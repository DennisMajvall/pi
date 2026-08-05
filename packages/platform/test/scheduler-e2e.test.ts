/**
 * Tests for Step 2.12 (Scheduler + execution overlay + end-to-end): the
 * execution overlay model (strictly separate from plan content), the minimal
 * deterministic scheduler (`ready` from `dependsOn`, `next` by priority then
 * id, capability resolution), the layered complexity detection + hybrid entry
 * trigger, and the end-to-end orchestrator that chains the 2.4–2.11 stages
 * into an approved plan persisted on disk and walks it to a capability
 * execution.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { capabilityId, planId, taskId } from "../src/identifier/index.ts";
import { PlanStore } from "../src/kernel/plan-store.ts";
import type { Plan, Task } from "../src/plan/index.ts";
import {
	assessComplexityLayered,
	attachOverlay,
	ClarificationRequiredError,
	CONSTRAINT_EXTRACTION_MODEL_KEY,
	type ComplexityDependencies,
	CRITIC_MODEL_KEY,
	completeTask,
	constraintExtractionStage,
	criticStage,
	deterministicPreFilter,
	EXECUTION_STRATEGY_MODEL_KEY,
	ExecutionTaskStatus,
	evaluateTrigger,
	executeApprovedPlan,
	executeTask,
	executionStrategyStage,
	failTask,
	GOAL_ANALYSIS_MODEL_KEY,
	goalAnalysisStage,
	METRICS_MODEL_KEY,
	markRunning,
	metricsStage,
	OPTIMIZER_MODEL_KEY,
	optimizerStage,
	type PlanningStages,
	resolveRequiredCapabilities,
	runPlanningPipeline,
	type SchedulerCapability,
	type StageCompletion,
	type StageModelRouting,
	schedulerNext,
	schedulerReady,
	TASK_DECOMPOSITION_MODEL_KEY,
	taskDecompositionStage,
} from "../src/planning/index.ts";
import { PlanSchema } from "../src/schema/plan.ts";
import type { EventBusService } from "../src/service/index.ts";

const tempDirs: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-platform-sched-"));
	tempDirs.push(root);
	return root;
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

function task(id: string, overrides: Partial<Task> = {}): Task {
	return {
		id: taskId(id),
		title: id,
		purpose: "purpose",
		deliverable: `deliverable-${id}`,
		inputs: [],
		outputs: [],
		dependsOn: [],
		requiredCapabilities: [capabilityId("tool.read")],
		verification: "",
		...overrides,
	};
}

function samplePlan(tasks: Task[] = [task("t1")], overrides: Partial<Plan> = {}): Plan {
	return {
		id: planId("plan-s"),
		schemaVersion: 1,
		goal: {
			summary: "Ship billing",
			successCriteria: ["deliverable-t1"],
			unknowns: [],
			requiresClarification: false,
			clarificationQuestions: [],
		},
		policy: {
			taskKind: "implementation",
			planningDepth: "medium",
			hierarchicalRefinement: false,
			parallelExecution: true,
			specialistAgents: false,
			requireApproval: true,
			verificationLevel: "basic",
			preferResearch: false,
			maxTasks: 5,
			dualPlanner: false,
		},
		constraints: [],
		assumptions: [],
		tasks,
		revisions: [],
		status: "approved",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function noopEvents(): EventBusService {
	return { emit: async () => {}, emitSync: async () => {} } as unknown as EventBusService;
}

// =========================================================================
// Execution overlay (§5, §12)
// =========================================================================

describe("execution overlay (§5, §12)", () => {
	it("attaches one pending entry per task with attempts 0 and no execution fields", () => {
		const plan = samplePlan([task("t1"), task("t2", { dependsOn: [taskId("t1")] })]);
		const overlay = attachOverlay(plan);
		expect(overlay.all()).toHaveLength(2);
		for (const entry of overlay.all()) {
			expect(entry.status).toBe(ExecutionTaskStatus.Pending);
			expect(entry.attempts).toBe(0);
			expect(entry.priority).toBe(0);
			expect(entry.responsibleExecutor).toBeUndefined();
			expect(entry.result).toBeUndefined();
		}
	});

	it("keeps execution state strictly separate from plan content", () => {
		const plan = samplePlan();
		const overlay = attachOverlay(plan);
		const running = markRunning(overlay, taskId("t1"), "tool.read");
		expect(running.get(taskId("t1"))?.status).toBe(ExecutionTaskStatus.Running);
		// The overlay is a side-table: the plan object never gains execution fields.
		expect(Value.Check(PlanSchema, plan)).toBe(true);
		expect(Object.hasOwn(plan.tasks[0]!, "status")).toBe(false);
	});

	it("transitions are pure and record attempts/executor/result/error", () => {
		const plan = samplePlan([task("t1")]);
		let overlay = attachOverlay(plan);
		overlay = markRunning(overlay, taskId("t1"), "tool.read");
		expect(overlay.get(taskId("t1"))?.attempts).toBe(1);
		overlay = completeTask(overlay, taskId("t1"), "read ok");
		expect(overlay.get(taskId("t1"))?.status).toBe(ExecutionTaskStatus.Done);
		expect(overlay.get(taskId("t1"))?.result).toBe("read ok");

		const failed = failTask(markRunning(overlay, taskId("t1"), "tool.read"), taskId("t1"), "boom");
		expect(failed.get(taskId("t1"))?.status).toBe(ExecutionTaskStatus.Failed);
		expect(failed.get(taskId("t1"))?.error).toBe("boom");
	});
});

// =========================================================================
// Minimal deterministic scheduler (§6.5)
// =========================================================================

describe("minimal deterministic scheduler (§6.5)", () => {
	it("ready(t) = t pending ∧ every dependsOn is done", () => {
		const plan = samplePlan([
			task("t1"),
			task("t2", { dependsOn: [taskId("t1")] }),
			task("t3", { dependsOn: [taskId("t2")] }),
		]);
		let overlay = attachOverlay(plan);
		expect(schedulerReady(plan, overlay).map(String)).toEqual(["t1"]);
		overlay = completeTask(overlay, taskId("t1"), "ok");
		expect(schedulerReady(plan, overlay).map(String)).toEqual(["t2"]);
		overlay = completeTask(overlay, taskId("t2"), "ok");
		expect(schedulerReady(plan, overlay).map(String)).toEqual(["t3"]);
	});

	it("next picks the ready task by priority then id (deterministic, no model)", () => {
		const plan = samplePlan([task("t1"), task("t2")]);
		let overlay = attachOverlay(plan, { priorities: { t2: -10 } });
		// Both t1 and t2 are root-ready; t2 has higher priority (lower number).
		expect(String(schedulerNext(plan, overlay)!)).toBe("t2");

		overlay = attachOverlay(plan); // equal priorities
		expect(String(schedulerNext(plan, overlay)!)).toBe("t1"); // the lexicographically smaller id
	});

	it("returns undefined when no task is ready", () => {
		const plan = samplePlan([task("t1"), task("t2", { dependsOn: [taskId("t1")] })]);
		// t1 is still running (not pending), t2 waits on t1 → nothing ready.
		const overlay = markRunning(attachOverlay(plan), taskId("t1"), "tool.read");
		expect(schedulerNext(plan, overlay)).toBeUndefined();
		// A fully-completed plan yields no ready tasks either.
		const allDone = completeTask(completeTask(overlay, taskId("t1"), "ok"), taskId("t2"), "ok");
		expect(schedulerReady(plan, allDone)).toEqual([]);
		expect(schedulerNext(plan, allDone)).toBeUndefined();
	});

	it("resolves requiredCapabilities and reports missing ids", () => {
		const cap: SchedulerCapability = {
			id: capabilityId("tool.read"),
			manifestId: "tool.read",
			name: "Read",
			run: async () => "data",
		};
		const resolution = resolveRequiredCapabilities(task("t1"), (capId) =>
			String(capId) === "tool.read" ? cap : undefined,
		);
		expect(resolution.resolved.map((c) => String(c.id))).toEqual(["tool.read"]);
		expect(resolution.missing).toEqual([]);

		const missing = resolveRequiredCapabilities(
			task("t1", { requiredCapabilities: [capabilityId("command.bash")] }),
			() => undefined,
		);
		expect(missing.resolved).toEqual([]);
		expect(missing.missing.map(String)).toEqual(["command.bash"]);
	});

	it("executeTask records the capability result and failure in the overlay", async () => {
		const plan = samplePlan([task("t1")]);
		let overlay = attachOverlay(plan);
		const cap: SchedulerCapability = {
			id: capabilityId("tool.read"),
			manifestId: "tool.read",
			name: "Read",
			run: async () => "file contents",
		};
		overlay = await executeTask(task("t1"), cap, overlay, { path: "x" });
		expect(overlay.get(taskId("t1"))?.status).toBe(ExecutionTaskStatus.Done);
		expect(overlay.get(taskId("t1"))?.result).toBe("file contents");
		expect(overlay.get(taskId("t1"))?.responsibleExecutor).toBe("tool.read");

		const boom: SchedulerCapability = {
			id: capabilityId("tool.read"),
			manifestId: "tool.read",
			name: "Read",
			run: async () => {
				throw new Error("read failed");
			},
		};
		overlay = await executeTask(task("t1"), boom, overlay, {});
		expect(overlay.get(taskId("t1"))?.status).toBe(ExecutionTaskStatus.Failed);
		expect(overlay.get(taskId("t1"))?.error).toBe("read failed");
	});

	it("executeApprovedPlan walks a dependency DAG to all-done in dependency order", async () => {
		const plan = samplePlan([
			task("t1"),
			task("t2", { dependsOn: [taskId("t1")], requiredCapabilities: [capabilityId("command.bash")] }),
			task("t3", { dependsOn: [taskId("t1")] }),
			task("t4", { dependsOn: [taskId("t2"), taskId("t3")] }),
		]);
		const order: string[] = [];
		const resolver = (capId: ReturnType<typeof capabilityId>): SchedulerCapability | undefined => {
			order.push(String(capId));
			return { id: capId, manifestId: String(capId), name: String(capId), run: async () => "ok" };
		};
		const overlay = await executeApprovedPlan(plan, attachOverlay(plan), resolver, () => ({}));
		expect(overlay.all().filter((e) => e.status === ExecutionTaskStatus.Done)).toHaveLength(4);
		expect(overlay.get(taskId("t4"))?.status).toBe(ExecutionTaskStatus.Done);
		// t1 runs before its dependents; t4 (the join) runs last.
		expect(order[0]).toBe("tool.read");
		expect(order[order.length - 1]).toBe("tool.read");
		expect(overlay.get(taskId("t4"))?.result).toBe("ok");
	});
});

// =========================================================================
// Layered complexity detection + hybrid trigger
// =========================================================================

describe("layered complexity detection + trigger", () => {
	it("deterministic pre-filter short-circuits a trivial prompt (no model call)", async () => {
		const pre = deterministicPreFilter({ userRequest: "hi" });
		expect(pre.escalate).toBe(false);
		expect(pre.score).toBeLessThan(30);
	});

	it("deterministic pre-filter escalates a long, multi-step prompt", () => {
		const longRequest = "Implement a full billing feature. ".repeat(20);
		const pre = deterministicPreFilter({ userRequest: longRequest, toolCallCount: 5, estimatedTokens: 3000 });
		expect(pre.escalate).toBe(true);
		expect(pre.reasons.length).toBeGreaterThan(0);
	});

	it("layered assessment composes pre-filter + cheap-model AI verdict", async () => {
		const aiRouting: StageModelRouting = { default: "cheap", stages: { complexity: "complex-1" } };
		const deps = {
			completion: async ({ model }: { model: string }) => {
				if (model === "complex-1") {
					return JSON.stringify({ planWarranted: true, reason: "deep scope" });
				}
				return "{}";
			},
			routing: aiRouting,
		} as { completion: StageCompletion; routing: StageModelRouting };
		const result = await assessComplexityLayered(
			{ userRequest: "big task", promptLength: 2400, toolCallCount: 4, estimatedTokens: 5000 },
			deps,
		);
		expect(result.stage).toBe("ai");
		expect(result.planWarranted).toBe(true);

		const trivial = await assessComplexityLayered({ userRequest: "ok" }, deps);
		expect(trivial.stage).toBe("pre_filter");
		expect(trivial.planWarranted).toBe(false);
	});

	it("explicit /plan always engages; a trivial prompt does not", async () => {
		const deps = {
			completion: async () => JSON.stringify({ planWarranted: true }),
			routing: { default: "cheap" },
		} as { completion: StageCompletion; routing: StageModelRouting };
		const explicit = await evaluateTrigger({ request: "anything", explicit: true }, deps);
		expect(explicit).toMatchObject({ engage: true, mode: "explicit" });

		const trivial = await evaluateTrigger({ request: "ok", explicit: false }, deps);
		expect(trivial).toMatchObject({ engage: false });
	});
});

// =========================================================================
// End-to-end orchestrator (request → approved plan → execution)
// =========================================================================

const routing: StageModelRouting = {
	default: "cheap",
	stages: {
		[GOAL_ANALYSIS_MODEL_KEY]: "goal-1",
		[EXECUTION_STRATEGY_MODEL_KEY]: "strat-1",
		[CONSTRAINT_EXTRACTION_MODEL_KEY]: "cons-1",
		[TASK_DECOMPOSITION_MODEL_KEY]: "tasks-1",
		[CRITIC_MODEL_KEY]: "critic-1",
		[OPTIMIZER_MODEL_KEY]: "optimizer-1",
		[METRICS_MODEL_KEY]: "metrics-1",
	},
};

function fakeCompletion(overrides: { optimizerSkipped?: boolean } = {}): StageCompletion {
	return async ({ model }) => {
		switch (model) {
			case "goal-1":
				return JSON.stringify({
					summary: "Ship billing",
					successCriteria: ["deliverable-t1"],
					unknowns: [],
					requiresClarification: false,
					clarificationQuestions: [],
				});
			case "strat-1":
				return JSON.stringify({
					taskKind: "implementation",
					planningDepth: "medium",
					hierarchicalRefinement: false,
					parallelExecution: true,
					specialistAgents: false,
					requireApproval: true,
					verificationLevel: "basic",
					preferResearch: false,
					maxTasks: 5,
					dualPlanner: false,
				});
			case "cons-1":
				return JSON.stringify({
					hardConstraints: [],
					softConstraints: [],
					resourceConstraints: [],
					policyConstraints: [],
				});
			case "tasks-1":
				return JSON.stringify({
					tasks: [
						{ id: "t1", title: "T1", purpose: "purpose", deliverable: "deliverable-t1" },
						{ id: "t2", title: "T2", purpose: "purpose", deliverable: "deliverable-t2" },
					],
				});
			case "critic-1":
				return JSON.stringify({
					missingTasks: [],
					duplicateTasks: [],
					circularDependencies: [],
					incorrectAssumptions: [],
					risks: [],
					questions: [],
				});
			case "optimizer-1":
				return overrides.optimizerSkipped ? "not json" : JSON.stringify({ notAPlan: true });
			case "metrics-1":
				return JSON.stringify({
					completeness: 90,
					confidence: 70,
					risk: "low",
					unknownCount: 0,
					missingInformation: [],
				});
			default:
				return "{}";
		}
	};
}

function buildStages(completion: StageCompletion): PlanningStages {
	return {
		goal: goalAnalysisStage(completion, routing),
		strategy: executionStrategyStage(completion, routing),
		constraints: constraintExtractionStage(completion, routing),
		tasks: taskDecompositionStage(completion, routing),
		critic: criticStage(completion, routing),
		optimizer: optimizerStage(completion, routing),
		metrics: metricsStage(completion, routing),
	};
}

describe("end-to-end orchestrator", () => {
	it("chains the full pipeline into an approved, validated, scored plan persisted on disk", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const events = await noopEvents();
		const emitted: string[] = [];
		events.emit = async (event: { type: string }) => {
			emitted.push(String((event as { type: string }).type));
		};

		const result = await runPlanningPipeline("Ship billing", buildStages(fakeCompletion()), {
			store,
			events,
		});

		expect(result.outcome).toBe("required");
		expect(result.plan.status).toBe("approved");
		expect(Value.Check(PlanSchema, result.plan)).toBe(true);
		expect(result.plan.tasks).toHaveLength(2);
		expect(result.plan.metrics?.completeness).toBe(90);
		// The approval gate bumps an `approval` revision.
		expect(result.plan.revisions.at(-1)?.reason).toBe("approval");

		// Persisted on disk (read-through).
		const loaded = await store.load(result.plan.id);
		expect(loaded.status).toBe("approved");

		// plan.created + plan.approved announced on the bus.
		expect(emitted).toEqual(["plan.created", "plan.approved"]);
	});

	it("an unconfigured AI goal stage aborts loudly rather than running an empty model", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const events = await noopEvents();
		const stages = buildStages(fakeCompletion());
		// Override goal to run with an empty routing (unconfigured).
		stages.goal = goalAnalysisStage(fakeCompletion(), { default: "", stages: {} });
		await expect(runPlanningPipeline("Ship billing", stages, { store, events })).rejects.toThrow(
			/no model configured/,
		);
	});

	it("a waived approval policy auto-approves the plan", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const events = await noopEvents();
		const completion = fakeCompletion();
		// Delegate but flip requireApproval off in the strategy output.
		const waiter = async ({ model }: { model: string }) => {
			if (model === "strat-1") {
				const base = JSON.parse(await completion({ model, systemPrompt: "", userPrompt: "" })) as Record<
					string,
					unknown
				>;
				return JSON.stringify({ ...base, requireApproval: false });
			}
			return completion({ model, systemPrompt: "", userPrompt: "" });
		};
		const result = await runPlanningPipeline("Ship billing", buildStages(waiter), { store, events });
		expect(result.outcome).toBe("auto_approved");
		expect(result.plan.status).toBe("approved");
	});

	it("throws ClarificationRequiredError when the goal needs clarification and no answers are given", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const events = await noopEvents();
		const completion: StageCompletion = async ({ model }) => {
			if (model === "goal-1") {
				return JSON.stringify({
					summary: "Ambiguous request",
					successCriteria: ["x"],
					unknowns: ["which provider?"],
					requiresClarification: true,
					clarificationQuestions: [{ question: "which provider?", blocking: true }],
				});
			}
			return fakeCompletion()({ model, systemPrompt: "", userPrompt: "" });
		};
		await expect(runPlanningPipeline("Ambiguous", buildStages(completion), { store, events })).rejects.toBeInstanceOf(
			ClarificationRequiredError,
		);
	});

	it("proceeds to an approved, executable plan when clarification answers are provided", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const events = await noopEvents();
		const plan = await runPlanningPipeline("Ship billing", buildStages(fakeCompletion()), {
			store,
			events,
			clarifyAnswers: { "which provider?": "stripe" },
		});
		expect(plan.plan.status).toBe("approved");
		// Answer recorded as a user assumption.
		expect(plan.plan.assumptions.some((a) => a.statement.includes("stripe"))).toBe(true);

		// Walking-skeleton execution: annotate the plan's tasks with the capability
		// they need (real decomposition leaves requiredCapabilities empty), then the
		// approved plan resolves a ready task to a capability execution and walks
		// the DAG to completion.
		const executable = {
			...plan.plan,
			tasks: plan.plan.tasks.map((t) => ({ ...t, requiredCapabilities: [capabilityId("tool.read")] })),
		};
		const resolver = (capId: ReturnType<typeof capabilityId>): SchedulerCapability | undefined => ({
			id: capId,
			manifestId: String(capId),
			name: String(capId),
			run: async () => "ok",
		});
		const overlay = await executeApprovedPlan(executable, attachOverlay(executable), resolver, () => ({}));
		expect(overlay.all().filter((e) => e.status === ExecutionTaskStatus.Done)).toHaveLength(2);
	});
});

// =========================================================================
// Planning behavior as a user would expect it (aggregate, not per-function)
// =========================================================================

/** A completion that routes the given model to a canned output, else the base fake. */
function completionWith(overrides: Partial<Record<string, string>>): StageCompletion {
	return async (req) => (req.model in overrides ? overrides[req.model]! : fakeCompletion()(req));
}

/** An optimizer output that is a *valid, improved* plan with a real dependency DAG. */
function optimizedPlanJson(): string {
	const plan = {
		...samplePlan(),
		goal: {
			summary: "Ship billing",
			successCriteria: ["deliverable-t1"],
			unknowns: [],
			requiresClarification: false,
			clarificationQuestions: [],
		},
		status: "draft" as const,
		revisions: [],
		tasks: ["t1", "t2", "t3", "t4"].map((id) => {
			const dependsOn =
				id === "t1" ? [] : id === "t2" || id === "t3" ? [taskId("t1")] : [taskId("t2"), taskId("t3")];
			return task(id, { dependsOn, requiredCapabilities: [capabilityId(`command.${id}`)] });
		}),
	};
	return JSON.stringify(plan);
}

describe("planning behavior a user would expect (§6.3 aggregate)", () => {
	it("[A] the approved plan carries a real dependency DAG and executes in dependency order", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const events = await noopEvents();
		// The optimizer returns a valid plan with a real DAG (t1 → {t2,t3} → t4).
		const result = await runPlanningPipeline(
			"Ship billing",
			buildStages(completionWith({ "optimizer-1": optimizedPlanJson() })),
			{ store, events },
		);

		// The optimizer's improved plan replaced the 2-task draft.
		expect(result.plan.tasks).toHaveLength(4);
		const dependsOn = (id: string) => result.plan.tasks.find((t) => String(t.id) === id)?.dependsOn.map(String) ?? [];
		expect(dependsOn("t2")).toEqual(["t1"]);
		expect(dependsOn("t3")).toEqual(["t1"]);
		expect(dependsOn("t4")).toEqual(["t2", "t3"]);

		// Approve → walk: t1 runs first, the join task t4 runs last, and the two
		// children of t1 both precede t4.
		const order: string[] = [];
		const resolver = (capId: ReturnType<typeof capabilityId>): SchedulerCapability | undefined => {
			order.push(String(capId));
			return { id: capId, manifestId: String(capId), name: String(capId), run: async () => "ok" };
		};
		const overlay = await executeApprovedPlan(result.plan, attachOverlay(result.plan), resolver, () => ({}));
		expect(overlay.get(taskId("t4"))?.status).toBe(ExecutionTaskStatus.Done);
		expect(order[0]).toBe("command.t1"); // t1 is the root and executes first
		expect(order[order.length - 1]).toBe("command.t4"); // t4 (join) executes last
		expect(order.indexOf("command.t2")).toBeLessThan(order.indexOf("command.t4"));
		expect(order.indexOf("command.t3")).toBeLessThan(order.indexOf("command.t4"));
		expect(overlay.all().filter((e) => e.status === ExecutionTaskStatus.Done)).toHaveLength(4);
	});

	it("[C] hard/resource constraints deterministically downgrade the policy through the pipeline", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const events = await noopEvents();
		// Strategy chooses deep/parallel; hard time + no-parallel constraints must
		// downgrade (never upgrade) to medium/serial in the approved plan.
		const completion = completionWith({
			"strat-1": JSON.stringify({
				taskKind: "implementation",
				planningDepth: "high",
				hierarchicalRefinement: true,
				parallelExecution: true,
				specialistAgents: true,
				requireApproval: true,
				verificationLevel: "strict",
				preferResearch: false,
				maxTasks: 10,
				dualPlanner: true,
			}),
			"cons-1": JSON.stringify({
				hardConstraints: ["All work must finish within 8 hours"],
				softConstraints: [],
				resourceConstraints: [
					"Run builds one at a time; no parallel",
					"Limited compute budget — no expensive specialist passes",
				],
				policyConstraints: [],
			}),
		});
		const result = await runPlanningPipeline("Ship billing", buildStages(completion), { store, events });
		expect(result.plan.policy.planningDepth).toBe("medium");
		expect(result.plan.policy.parallelExecution).toBe(false);
		expect(result.plan.policy.specialistAgents).toBe(false);
		expect(result.plan.policy.dualPlanner).toBe(false);
	});

	it("[D] a user /plan always engages planning and produces a plan, even for a trivial request", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const events = await noopEvents();
		const decision = await evaluateTrigger(
			{ request: "hi", explicit: true },
			{ completion: fakeCompletion(), routing },
		);
		expect(decision).toMatchObject({ engage: true, mode: "explicit" });

		const result = await runPlanningPipeline("hi", buildStages(fakeCompletion()), { store, events });
		expect(result.plan.status).toBe("approved");
		expect(Value.Check(PlanSchema, result.plan)).toBe(true);
	});

	it("[D] auto-trigger engages planning for a complex prompt and skips a trivial one (no pipeline run)", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const events = await noopEvents();
		const complexDeps: ComplexityDependencies = {
			completion: async () => JSON.stringify({ planWarranted: true }),
			routing,
		};

		// A prompt the layered check deems complex → engage + pipeline → a plan.
		const autoComplex = await evaluateTrigger(
			{
				request: "ship the whole billing platform",
				explicit: false,
				complexity: { promptLength: 3000, toolCallCount: 6 },
			},
			complexDeps,
		);
		expect(autoComplex).toMatchObject({ engage: true, mode: "auto" });
		const planned = await runPlanningPipeline("ship the whole billing platform", buildStages(fakeCompletion()), {
			store,
			events,
		});
		expect(planned.plan.status).toBe("approved");

		// A trivial prompt is left alone — no pipeline run, no plan persisted.
		const trivial = await evaluateTrigger({ request: "ok", explicit: false }, complexDeps);
		expect(trivial).toMatchObject({ engage: false });
	});
});

describe("non-perfect plans are persisted + iterable (validation relaxation)", () => {
	it("a coverage gap (unreachable success criterion) still yields an approved, persisted plan with a validation note", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const events = await noopEvents();
		// The decomposition only produces "deliverable-t1", so the goal's extra
		// success criterion is unreachable — a real model might phrase criteria
		// differently than task artifacts.
		const completion = completionWith({
			"goal-1": JSON.stringify({
				summary: "Ship billing",
				successCriteria: ["deliverable-t1", "ghost-criterion"],
				unknowns: [],
				requiresClarification: false,
				clarificationQuestions: [],
			}),
		});
		const result = await runPlanningPipeline("Ship billing", buildStages(completion), { store, events });

		expect(result.plan.status).toBe("approved");
		// The gap is surfaced as a low-confidence note rather than aborting the plan.
		expect(result.plan.assumptions.some((a) => a.statement.includes("ghost-criterion"))).toBe(true);
		// Persisted, so it can be opened in /plans, edited, and iterated on.
		const loaded = await store.load(result.plan.id);
		expect(loaded.status).toBe("approved");
		expect(loaded.assumptions.some((a) => a.statement.includes("ghost-criterion"))).toBe(true);
	});
});
