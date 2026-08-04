/**
 * Tests for Task Decomposition (Step 2.7): the AI stage emits unordered tasks,
 * the deterministic dedupe + maxTasks budget pass runs, and decomposed tasks
 * complete onto the full 2.1 `Task` shape stored on a plan.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { planId } from "../src/identifier/index.ts";
import { PlanStore } from "../src/kernel/plan-store.ts";
import type { Goal, Plan, PlanningPolicy } from "../src/plan/index.ts";
import {
	completeTasks,
	type DecomposedTask,
	dedupeTasks,
	enforceMaxTasks,
	type PlanningStageRunContext,
	type StageCompletion,
	type StageModelRouting,
	TASK_DECOMPOSITION_MODEL_KEY,
	TaskDecompositionSchema,
	taskDecompositionStage,
} from "../src/planning/index.ts";
import { definePlanningStageCapability } from "../src/planning/stage.ts";
import { PlanSchema, TaskSchema } from "../src/schema/plan.ts";

const tempDirs: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-platform-tasks-"));
	tempDirs.push(root);
	return root;
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

const routing: StageModelRouting = { default: "capable-1", stages: { [TASK_DECOMPOSITION_MODEL_KEY]: "capable-1" } };

function sampleGoal(): Goal {
	return {
		summary: "Ship the billing feature",
		successCriteria: ["Invoices generate on schedule"],
		unknowns: [],
		requiresClarification: false,
		clarificationQuestions: [],
	};
}

function samplePolicy(maxTasks = 5): PlanningPolicy {
	return {
		taskKind: "implementation",
		planningDepth: "medium",
		hierarchicalRefinement: false,
		parallelExecution: true,
		specialistAgents: false,
		requireApproval: true,
		verificationLevel: "basic",
		preferResearch: false,
		maxTasks,
		dualPlanner: false,
	};
}

function sampleTasks(): DecomposedTask[] {
	return [
		{ id: "t1", title: "Define schema", purpose: "Contract for invoices", deliverable: "schema" },
		{ id: "t2", title: "Generate invoices", purpose: "Produce the invoice set", deliverable: "invoice set" },
	];
}

function capturingCompletion(models: string[], tasks: DecomposedTask[]): StageCompletion {
	return async ({ model }) => {
		models.push(model);
		return JSON.stringify({ tasks });
	};
}

function runCtx(): PlanningStageRunContext {
	return {} as unknown as PlanningStageRunContext;
}

describe("Task Decomposition stage", () => {
	it("emits unordered tasks validating against TaskDecompositionSchema", async () => {
		const models: string[] = [];
		const stage = taskDecompositionStage(capturingCompletion(models, sampleTasks()), routing);
		const output = (await stage.run({ goal: sampleGoal(), policy: samplePolicy() }, runCtx())) as {
			tasks: DecomposedTask[];
		};
		expect(Value.Check(TaskDecompositionSchema, output)).toBe(true);
		expect(models).toEqual(["capable-1"]);
	});

	it("aborts (§11 mandatory) on persistent invalid output", async () => {
		const stage = taskDecompositionStage(
			async () => JSON.stringify({ tasks: [{ id: "t1", dependsOn: ["x"] }] }),
			routing,
		);
		await expect(stage.run({ goal: sampleGoal(), policy: samplePolicy() }, runCtx())).rejects.toThrow(
			"task_decomposition",
		);
	});

	it("is a valid orchestration capability", () => {
		const capability = definePlanningStageCapability(taskDecompositionStage(capturingCompletion([], sampleTasks())));
		expect(capability.manifest.id).toBe("orchestration.tasks");
		expect(capability.manifest.category).toBe("orchestration");
	});
});

describe("deterministic dedupe + budget + completion", () => {
	it("dedupes by deliverable (first wins)", () => {
		const tasks = [
			{ id: "a", title: "A", purpose: "p", deliverable: "x" },
			{ id: "b", title: "B", purpose: "p", deliverable: "x" },
			{ id: "c", title: "C", purpose: "p", deliverable: "y" },
		];
		expect(dedupeTasks(tasks).map((t) => t.id)).toEqual(["a", "c"]);
	});

	it("caps an over-budget decomposition to maxTasks", () => {
		const tasks = Array.from({ length: 10 }, (_, i) => ({
			id: `t${i}`,
			title: `T${i}`,
			purpose: "p",
			deliverable: `d${i}`,
		}));
		expect(enforceMaxTasks(tasks, 3)).toHaveLength(3);
		expect(enforceMaxTasks(tasks, 10)).toHaveLength(10);
	});

	it("completes partial tasks onto full schema-valid Task objects", () => {
		const completed = completeTasks(sampleTasks());
		expect(completed).toHaveLength(2);
		for (const task of completed) {
			expect(Value.Check(TaskSchema, task)).toBe(true);
		}
		expect(completed[0]).toMatchObject({ dependsOn: [], requiredCapabilities: [], verification: "" });
	});

	it("stores deduped, budgeted, completed tasks on a plan via PlanStore", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const plan: Plan = {
			id: planId("plan-t"),
			schemaVersion: 1,
			goal: sampleGoal(),
			policy: samplePolicy(3),
			constraints: [],
			assumptions: [],
			tasks: [],
			revisions: [],
			status: "draft",
			createdAt: 1,
			updatedAt: 1,
		};
		const decomposed = [
			...sampleTasks(),
			{ id: "t3", title: "Duplicate", purpose: "p", deliverable: "schema" }, // duplicate deliverable
			{ id: "t4", title: "Extra", purpose: "p", deliverable: "extra" },
		];
		plan.tasks = completeTasks(enforceMaxTasks(decomposed, plan.policy.maxTasks));
		await store.save(plan);

		expect(Value.Check(PlanSchema, plan)).toBe(true);
		const loaded = await store.load("plan-t");
		expect(loaded.tasks.map((t) => t.deliverable)).toEqual(["schema", "invoice set", "extra"]); // dedupe dropped the dup; budget 3 keeps all
	});
});
