/**
 * Tests for the Plan Critic + Optimizer (Step 2.9): the adversarial critique,
 * the within-intent refinement, §11 optional-stage skipping, and §8
 * critic/optimizer revision recording.
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
	appendRevision,
	CRITIC_MODEL_KEY,
	CriticSchema,
	type Critique,
	changedTaskIds,
	criticStage,
	OPTIMIZER_MODEL_KEY,
	type OptionalStageResult,
	optimizerStage,
	type PlanningStageRunContext,
	type StageModelRouting,
} from "../src/planning/index.ts";
import { definePlanningStageCapability } from "../src/planning/stage.ts";
import { PlanSchema } from "../src/schema/plan.ts";

const tempDirs: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-platform-critic-"));
	tempDirs.push(root);
	return root;
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

const criticRouting: StageModelRouting = { default: "capable-1", stages: { [CRITIC_MODEL_KEY]: "c-1" } };
const optimizerRouting: StageModelRouting = { default: "capable-1", stages: { [OPTIMIZER_MODEL_KEY]: "o-1" } };

function runCtx(): PlanningStageRunContext {
	return {} as unknown as PlanningStageRunContext;
}

function task(id: string, overrides: Partial<Task> = {}): Task {
	return {
		id: taskId(id),
		title: id,
		purpose: "p",
		deliverable: `d-${id}`,
		inputs: [],
		outputs: [],
		dependsOn: [],
		requiredCapabilities: [],
		verification: "",
		...overrides,
	};
}

function sampleCritique(): Critique {
	return {
		missingTasks: ["rollback handler"],
		duplicateTasks: [],
		circularDependencies: [],
		incorrectAssumptions: ["assumption X"],
		risks: ["payment provider downtime"],
		questions: ["which provider?"],
	};
}

function samplePlan(id = "plan-c"): Plan {
	return {
		id: planId(id),
		schemaVersion: 1,
		goal: {
			summary: "Ship billing",
			successCriteria: ["x"],
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
		tasks: [task("t1")],
		revisions: [],
		status: "draft",
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("Plan Critic stage", () => {
	it("returns a critique validating against CriticSchema on the routed model", async () => {
		const models: string[] = [];
		const stage = criticStage(async ({ model }) => {
			models.push(model);
			return JSON.stringify(sampleCritique());
		}, criticRouting);
		const result = (await stage.run(
			{ goal: samplePlan().goal, tasks: [], edges: [], policy: samplePlan().policy },
			runCtx(),
		)) as OptionalStageResult<Critique>;
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") {
			expect(Value.Check(CriticSchema, result.output)).toBe(true);
		}
		expect(models).toEqual(["c-1"]);
	});

	it("skips (§11 optional) rather than aborts on persistent invalid output", async () => {
		const stage = criticStage(async () => JSON.stringify({ missingTasks: 42 }), criticRouting);
		const result = (await stage.run(
			{ goal: samplePlan().goal, tasks: [], edges: [], policy: samplePlan().policy },
			runCtx(),
		)) as OptionalStageResult<Critique>;
		expect(result.kind).toBe("skipped");
	});

	it("is a valid orchestration capability", () => {
		const capability = definePlanningStageCapability(criticStage(async () => "", criticRouting));
		expect(capability.manifest.id).toBe("orchestration.critic");
		expect(capability.manifest.category).toBe("orchestration");
	});
});

describe("Plan Optimizer stage", () => {
	it("returns an updated plan validating against PlanSchema on the routed model", async () => {
		const models: string[] = [];
		const improved = samplePlan();
		improved.tasks = [task("t1"), task("t2")];
		const stage = optimizerStage(async ({ model }) => {
			models.push(model);
			return JSON.stringify(improved);
		}, optimizerRouting);
		const result = (await stage.run(
			{ plan: samplePlan(), policy: samplePlan().policy },
			runCtx(),
		)) as OptionalStageResult<Plan>;
		expect(models).toEqual(["o-1"]);
		if (result.kind === "ok") {
			expect(Value.Check(PlanSchema, result.output)).toBe(true);
			expect(result.output.tasks).toHaveLength(2);
		}
	});

	it("skips (§11 optional) rather than aborts on persistent invalid output", async () => {
		const stage = optimizerStage(async () => JSON.stringify({ id: 5 }), optimizerRouting);
		const result = (await stage.run(
			{ plan: samplePlan(), policy: samplePlan().policy },
			runCtx(),
		)) as OptionalStageResult<Plan>;
		expect(result.kind).toBe("skipped");
	});
});

describe("§8 revision recording", () => {
	it("changedTaskIds reports added/removed/modified tasks", () => {
		const before = [task("t1", { purpose: "a" }), task("t2")];
		const after = [task("t1", { purpose: "b" }), task("t3")];
		expect(changedTaskIds(before, after).map(String).sort()).toEqual(["t1", "t2", "t3"]);
	});

	it("appendRevision records an optimizer revision with the next version and updatedAt", () => {
		const plan = appendRevision(
			samplePlan(),
			"optimizer",
			changedTaskIds(samplePlan().tasks, [task("t1"), task("t2")]),
		);
		expect(plan.revisions).toHaveLength(1);
		expect(plan.revisions[0]).toMatchObject({ version: 1, reason: "optimizer" });
		expect(plan.revisions[0]!.changedTaskIds.map(String)).toEqual(["t2"]);
		const again = appendRevision(plan, "critic", []);
		expect(again.revisions.map((r) => r.version)).toEqual([1, 2]);
	});

	it("persists the optimizer result with a revision via PlanStore", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const before = samplePlan("plan-o");
		await store.save(before);

		const optimized = {
			...before,
			tasks: [task("t1"), task("t2")],
			goal: { ...before.goal, summary: "Ship billing" }, // intent preserved
		};
		const ids = changedTaskIds(before.tasks, optimized.tasks);
		const final = appendRevision(optimized, "optimizer", ids);
		await store.save(final);

		const loaded = await store.load("plan-o");
		expect(Value.Check(PlanSchema, loaded)).toBe(true);
		expect(loaded.tasks).toHaveLength(2);
		expect(loaded.revisions[0]).toMatchObject({ reason: "optimizer", version: 1 });
		expect(loaded.goal.summary).toBe("Ship billing");
	});
});
