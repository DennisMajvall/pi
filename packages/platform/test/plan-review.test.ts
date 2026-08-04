/**
 * Tests for the User Review / approval gate and the schema-preserving
 * `user_edit` capability (Step 2.11): the `needs_review → approved` transition
 * honoring `policy.requireApproval`, the approval-gate capability, the plan
 * editor's eight edit operations (each schema-preserving, DAG-preserving, and
 * revision-bumping), the conversational directive parser, and the deterministic
 * plan view renderer.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { planId, taskId } from "../src/identifier/index.ts";
import { PlanStore } from "../src/kernel/plan-store.ts";
import type { Plan, Task } from "../src/plan/index.ts";
import {
	applyPlanEdit,
	approvePlan,
	autoApprovePlan,
	definePlanningStageCapability,
	EVENT_PLAN_APPROVED,
	evaluateReviewGate,
	type PlanningStageRunContext,
	parsePlanEdit,
	type ReviewGateDecision,
	renderPlanDag,
	renderPlanView,
	requestReview,
	reviewGateStage,
	userEditStage,
} from "../src/planning/index.ts";
import { PlanSchema } from "../src/schema/plan.ts";

const tempDirs: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-platform-review-"));
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
		deliverable: `delivery-${id}`,
		inputs: [],
		outputs: [],
		dependsOn: [],
		requiredCapabilities: [],
		verification: "",
		...overrides,
	};
}

function samplePlan(overrides: Partial<Plan> = {}): Plan {
	return {
		id: planId("plan-r"),
		schemaVersion: 1,
		goal: {
			summary: "Ship billing",
			successCriteria: ["delivery-t1"],
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
			maxTasks: 8,
			dualPlanner: false,
		},
		constraints: [],
		assumptions: [],
		tasks: [task("t1", { title: "frontend" }), task("t2", { title: "backend", dependsOn: [taskId("t1")] })],
		revisions: [],
		status: "draft",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

/** Fake event bus recording emitted event types. */
function fakeEvents() {
	const types: string[] = [];
	const emit = async (event: { type: string }): Promise<void> => {
		types.push(event.type);
	};
	return { emit, types };
}

function runCtx(store: PlanStore, events: { emit: (e: { type: string }) => Promise<void> }): PlanningStageRunContext {
	return { store, events } as unknown as PlanningStageRunContext;
}

describe("review gate decision (§6.3.10)", () => {
	it("requires approval when policy.requireApproval is true (default for medium+)", () => {
		const decision: ReviewGateDecision = evaluateReviewGate(samplePlan());
		expect(decision).toEqual({ kind: "required" });
	});

	it("auto-approves when the policy waives approval", () => {
		const plan = samplePlan({ policy: { ...samplePlan().policy, requireApproval: false } });
		const decision = evaluateReviewGate(plan);
		expect(decision.kind).toBe("auto_approved");
	});
});

describe("status transitions (§8)", () => {
	it("requestReview moves draft → needs_review without adding a revision", () => {
		const next = requestReview(samplePlan());
		expect(next.status).toBe("needs_review");
		expect(next.revisions).toHaveLength(0);
		expect(next.updatedAt).toBeGreaterThan(0);
	});

	it("requestReview is idempotent for a plan already in needs_review", () => {
		const once = requestReview(samplePlan());
		expect(requestReview(once).status).toBe("needs_review");
	});

	it("requestReview throws from a non-reviewable status", () => {
		expect(() => requestReview(samplePlan({ status: "approved" }))).toThrow(/cannot request review/);
	});

	it("approvePlan flips needs_review → approved and records an approval revision (no task changes)", () => {
		const reviewed = requestReview(samplePlan());
		const next = approvePlan(reviewed);
		expect(next.status).toBe("approved");
		expect(next.revisions).toHaveLength(1);
		expect(next.revisions[0]).toMatchObject({ reason: "approval", changedTaskIds: [] });
		expect(Value.Check(PlanSchema, next)).toBe(true);
	});

	it("approvePlan requires needs_review first", () => {
		expect(() => approvePlan(samplePlan())).toThrow(/request review first/);
	});

	it("autoApprovePlan goes straight to approved from draft for a waived policy", () => {
		const next = autoApprovePlan(samplePlan({ policy: { ...samplePlan().policy, requireApproval: false } }));
		expect(next.status).toBe("approved");
		expect(next.revisions[0]?.reason).toBe("approval");
	});
});

describe("review gate capability (orchestration.plan.review)", () => {
	it("is a valid orchestration capability", () => {
		const capability = definePlanningStageCapability(reviewGateStage);
		expect(capability.manifest.id).toBe("orchestration.plan.review");
		expect(capability.manifest.category).toBe("orchestration");
	});

	it("marks a finished draft as needs_review and emits no approval event", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		await store.save(samplePlan());
		const events = fakeEvents();
		const next = (await reviewGateStage.run({ planId: "plan-r", action: "review" }, runCtx(store, events))) as Plan;
		expect(next.status).toBe("needs_review");
		expect(events.types).not.toContain(EVENT_PLAN_APPROVED);
	});

	it("approves a needs_review plan, persists, and emits plan.approved", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		await store.save(requestReview(samplePlan()));
		const events = fakeEvents();
		const next = (await reviewGateStage.run({ planId: "plan-r", action: "approve" }, runCtx(store, events))) as Plan;
		expect(next.status).toBe("approved");
		expect(events.types).toContain(EVENT_PLAN_APPROVED);
		expect((await store.load("plan-r")).status).toBe("approved");
	});

	it("does not force-approve a still-draft plan whose policy requires approval", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		await store.save(samplePlan());
		const events = fakeEvents();
		const next = (await reviewGateStage.run({ planId: "plan-r", action: "approve" }, runCtx(store, events))) as Plan;
		expect(next.status).toBe("needs_review");
		expect(events.types).not.toContain(EVENT_PLAN_APPROVED);
	});
});

describe("schema-preserving user_edit (orchestration.plan.edit)", () => {
	const expectValid = (plan: Plan): void => {
		expect(Value.Check(PlanSchema, plan)).toBe(true);
		expect(plan.revisions[plan.revisions.length - 1]?.reason).toBe("user_edit");
	};

	it("renames a task", () => {
		const next = applyPlanEdit(samplePlan(), { op: "rename", task: "t1", title: "UI shell" });
		expect(next.tasks.find((t) => t.id === "t1")?.title).toBe("UI shell");
		expectValid(next);
	});

	it("repurposes a task and rewires downstream inputs referencing the old deliverable", () => {
		const plan = samplePlan({
			tasks: [task("t1", { title: "auth" }), task("t2", { title: "app", inputs: ["delivery-t1"] })],
		});
		const next = applyPlanEdit(plan, {
			op: "repurpose",
			task: "t1",
			purpose: "SSO",
			deliverable: "sso-token",
		});
		expect(next.tasks.find((t) => t.id === "t1")?.deliverable).toBe("sso-token");
		expect(next.tasks.find((t) => t.id === "t2")?.inputs).toContain("sso-token");
		expectValid(next);
	});

	it("adds a dependency (move X after Y) and rejects a cycle", () => {
		const plan = samplePlan({ tasks: [task("t1"), task("t2"), task("t3", { dependsOn: [taskId("t2")] })] });
		const next = applyPlanEdit(plan, { op: "add_dependency", task: "t2", dependsOn: ["t1"] });
		expect(next.tasks.find((t) => t.id === "t2")?.dependsOn.map(String)).toContain("t1");
		expectValid(next);

		const cyclic: Plan = {
			...samplePlan(),
			tasks: [task("t1", { dependsOn: [taskId("t2")] }), task("t2", { dependsOn: [taskId("t1")] })],
		};
		expect(() => applyPlanEdit(cyclic, { op: "add_dependency", task: "t1", dependsOn: ["t2"] })).toThrow(/cycle/);
	});

	it("removes a dependency (run in parallel)", () => {
		const plan = samplePlan({ tasks: [task("t1"), task("t2", { dependsOn: [taskId("t1")] })] });
		const next = applyPlanEdit(plan, { op: "remove_dependency", task: "t2", dependsOn: ["t1"] });
		expect(next.tasks.find((t) => t.id === "t2")?.dependsOn).toEqual([]);
		expectValid(next);
	});

	it("merges two tasks, rewiring dependents to the merged id", () => {
		const plan = samplePlan({
			tasks: [
				task("t1", { title: "frontend", deliverable: "fe" }),
				task("t2", { title: "backend", deliverable: "be" }),
				task("t3", { title: "deploy", dependsOn: [taskId("t1"), taskId("t2")] }),
			],
		});
		const next = applyPlanEdit(plan, {
			op: "merge",
			tasks: ["t1", "t2"],
			into: { title: "fullstack", deliverable: "fs" },
		});
		expect(next.tasks).toHaveLength(2);
		const fullstack = next.tasks.find((t) => t.id === "t1");
		expect(fullstack?.title).toBe("fullstack");
		expect(fullstack?.deliverable).toBe("fs");
		expect(next.tasks.find((t) => t.id === "t3")?.dependsOn.map(String)).toEqual(["t1"]);
		expectValid(next);
	});

	it("splits a task into parts and makes dependents wait on all parts", () => {
		const plan = samplePlan({
			tasks: [task("t1", { title: "auth" }), task("t2", { title: "app", dependsOn: [taskId("t1")] })],
		});
		const next = applyPlanEdit(plan, {
			op: "split",
			task: "t1",
			parts: [{ title: "login" }, { title: "permissions" }],
		});
		const ids = next.tasks.filter((t) => t.id === "t1-1" || t.id === "t1-2");
		expect(ids).toHaveLength(2);
		expect(next.tasks.find((t) => t.id === "t2")?.dependsOn.map(String)).toEqual(["t1-1", "t1-2"]);
		expectValid(next);
	});

	it("adds a constraint", () => {
		const next = applyPlanEdit(samplePlan(), { op: "add_constraint", kind: "hard", description: "No cloud" });
		expect(next.constraints).toContainEqual({ kind: "hard", description: "No cloud" });
		expectValid(next);
	});

	it("sets a policy field (validated against the policy schema)", () => {
		const next = applyPlanEdit(samplePlan(), { op: "set_policy", field: "requireApproval", value: false });
		expect(next.policy.requireApproval).toBe(false);
		expectValid(next);
		expect(() =>
			applyPlanEdit(samplePlan(), { op: "set_policy", field: "parallelExecution", value: "nope" }),
		).toThrow(/invalid value/);
	});

	it("applies edits through the stage capability and persists", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		await store.save(samplePlan());
		const events = fakeEvents();
		const next = (await userEditStage.run(
			{ planId: "plan-r", edit: { op: "rename", task: "t1", title: "UI shell" } },
			runCtx(store, events),
		)) as Plan;
		expect(next.tasks.find((t) => t.id === "t1")?.title).toBe("UI shell");
		expect((await store.load("plan-r")).tasks.find((t) => t.id === "t1")?.title).toBe("UI shell");
	});
});

describe("conversational directive parser", () => {
	it("parses merge into", () => {
		const edit = parsePlanEdit("merge tasks t1 and t2 into fullstack", samplePlan());
		expect(edit).toMatchObject({ op: "merge", tasks: ["t1", "t2"] });
	});

	it("parses merge without an explicit into title", () => {
		const edit = parsePlanEdit("merge t1 and t2", samplePlan());
		expect(edit.op).toBe("merge");
	});

	it("parses move-after as an added dependency", () => {
		const edit = parsePlanEdit("move backend after frontend", samplePlan());
		expect(edit).toMatchObject({ op: "add_dependency", task: "t2", dependsOn: ["t1"] });
	});

	it("parses run-in-parallel by dropping the existing edge", () => {
		const plan = samplePlan({
			tasks: [task("t1", { title: "frontend" }), task("t2", { title: "backend", dependsOn: [taskId("t1")] })],
		});
		const edit = parsePlanEdit("run backend in parallel with frontend", plan);
		expect(edit.op).toBe("remove_dependency");
		const next = applyPlanEdit(plan, edit);
		expect(next.tasks.find((t) => t.id === "t2")?.dependsOn).toEqual([]);
	});

	it("parses split into parts", () => {
		const edit = parsePlanEdit("split t1 into login, permissions", samplePlan());
		expect(edit.op).toBe("split");
	});

	it("parses set-policy with boolean coercion", () => {
		const edit = parsePlanEdit("set requireApproval to false", samplePlan());
		expect(edit).toMatchObject({ op: "set_policy", field: "requireApproval", value: false });
	});

	it("throws for an unsupported directive", () => {
		expect(() => parsePlanEdit("add a unicorn", samplePlan())).toThrow(/unsupported directive/);
	});
});

describe("plan view renderer", () => {
	it("renders head, tasks, DAG, and revision history deterministically", () => {
		const plan = requestReview(samplePlan());
		const view = renderPlanView(plan);
		expect(view).toContain("# Plan plan-r");
		expect(view).toContain("[needs_review]");
		expect(view).toContain("approval required");
		expect(view).toContain("frontend");
		expect(view).toContain("DAG:");
		expect(renderPlanView(plan)).toBe(view);
	});

	it("renders an indented DAG outline with dependency depth", () => {
		const plan = samplePlan({ tasks: [task("t1"), task("t2", { dependsOn: [taskId("t1")] })] });
		const dag = renderPlanDag(plan);
		expect(dag).toContain("t1");
		expect(dag).toContain("t2");
		expect(dag).toContain("critical path");
	});
});
