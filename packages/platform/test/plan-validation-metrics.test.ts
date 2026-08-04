/**
 * Tests for Plan Validation + Metrics (Step 2.10): the deterministic validator
 * (schema, acyclicity, coverage), the DAG-derived `parallelism`, the optional
 * non-mutating AI metrics stage, and `combineMetrics` producing a §14 `Metrics`
 * that validates against `PlanSchema` and round-trips via the PlanStore.
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
	type AiAssessedMetrics,
	AiAssessedMetricsSchema,
	analyzeDag,
	combineMetrics,
	computeParallelism,
	METRICS_MODEL_KEY,
	metricsStage,
	type OptionalStageResult,
	type PlanningStageRunContext,
	type StageModelRouting,
	ValidationIssueCode,
	validatePlan,
} from "../src/planning/index.ts";
import { definePlanningStageCapability } from "../src/planning/stage.ts";
import { PlanSchema } from "../src/schema/plan.ts";

const tempDirs: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-platform-validation-"));
	tempDirs.push(root);
	return root;
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

const metricsRouting: StageModelRouting = { default: "cheap-1", stages: { [METRICS_MODEL_KEY]: "m-1" } };

function runCtx(): PlanningStageRunContext {
	return {} as unknown as PlanningStageRunContext;
}

function task(id: string, overrides: Partial<Task> = {}): Task {
	return {
		id: taskId(id),
		title: id,
		purpose: "purpose",
		deliverable: `deliverable-${id}`,
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
		id: planId("plan-v"),
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
		tasks: [task("t1")],
		revisions: [],
		status: "draft",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

describe("deterministic validation (§6.3.8)", () => {
	it("passes a schema-valid, acyclic, fully-covered plan", () => {
		const plan = samplePlan({
			goal: { ...samplePlan().goal, successCriteria: ["deliverable-t1"] },
			tasks: [task("t1"), task("t2", { inputs: ["deliverable-t1"] })],
		});
		const result = validatePlan(plan);
		expect(result.valid).toBe(true);
		expect(result.issues).toEqual([]);
	});

	it("reports a schema violation as a pipeline bug", () => {
		const plan = {
			...samplePlan(),
			status: "invalid_status",
		} as unknown as Plan;
		const result = validatePlan(plan);
		expect(result.valid).toBe(false);
		expect(result.issues.some((i) => i.code === ValidationIssueCode.Schema)).toBe(true);
	});

	it("reports cycles re-run on the persisted dependsOn DAG", () => {
		const plan = samplePlan({
			tasks: [task("t1", { dependsOn: [taskId("t2")] }), task("t2", { dependsOn: [taskId("t1")] })],
		});
		const result = validatePlan(plan);
		expect(result.valid).toBe(false);
		expect(result.issues.some((i) => i.code === ValidationIssueCode.Cycle)).toBe(true);
	});

	it("flags a success criterion no task output produces", () => {
		const plan = samplePlan({
			goal: { ...samplePlan().goal, successCriteria: ["ghost-criterion"] },
		});
		const result = validatePlan(plan);
		expect(result.issues.some((i) => i.code === ValidationIssueCode.UnreachableCriterion)).toBe(true);
	});

	it("flags a task with an empty purpose", () => {
		const plan = samplePlan({ tasks: [task("t1", { purpose: "   " })] });
		const result = validatePlan(plan);
		expect(result.issues.some((i) => i.code === ValidationIssueCode.TaskPurpose)).toBe(true);
	});

	it("flags duplicate deliverables between two tasks", () => {
		const plan = samplePlan({
			tasks: [task("t1", { deliverable: "widget" }), task("t2", { deliverable: "widget" })],
		});
		const result = validatePlan(plan);
		expect(result.issues.some((i) => i.code === ValidationIssueCode.DuplicateDeliverable)).toBe(true);
	});
});

describe("DAG-derived metrics (parallelism)", () => {
	it("returns 0 for an empty task set", () => {
		expect(computeParallelism([])).toBe(0);
	});

	it("scores a long chain low", () => {
		const tasks = [task("t1"), task("t2", { dependsOn: [taskId("t1")] }), task("t3", { dependsOn: [taskId("t2")] })];
		expect(computeParallelism(tasks)).toBe(33);
	});

	it("scores a fully parallel fan-out at 100", () => {
		const tasks = [task("t1"), task("t2"), task("t3")];
		expect(computeParallelism(tasks)).toBe(100);
	});

	it("analyzeDag reports critical path and width", () => {
		const a = analyzeDag([
			task("t1"),
			task("t2", { dependsOn: [taskId("t1")] }),
			task("t3", { dependsOn: [taskId("t1")] }),
		]);
		expect(a).toMatchObject({ taskCount: 3, maxRank: 1, maxRankWidth: 2 });
		expect(a.dependencyDensity).toBeCloseTo(2 / 3);
	});
});

describe("AI Metrics stage (§6.3.9, optional, non-mutating)", () => {
	const ai: AiAssessedMetrics = {
		completeness: 90,
		confidence: 70,
		risk: "medium",
		unknownCount: 2,
		missingInformation: ["provider choice"],
	};

	it("returns an AiAssessedMetrics validating against its schema on the routed model", async () => {
		const models: string[] = [];
		const stage = metricsStage(async ({ model }) => {
			models.push(model);
			return JSON.stringify(ai);
		}, metricsRouting);
		const result = (await stage.run(
			{ plan: samplePlan(), analysis: analyzeDag(samplePlan().tasks) },
			runCtx(),
		)) as OptionalStageResult<AiAssessedMetrics>;
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") {
			expect(Value.Check(AiAssessedMetricsSchema, result.output)).toBe(true);
		}
		expect(models).toEqual(["m-1"]);
	});

	it("skips (§11 optional) rather than aborts on persistent invalid output", async () => {
		const stage = metricsStage(async () => JSON.stringify({ completeness: "high" }), metricsRouting);
		const result = (await stage.run(
			{ plan: samplePlan(), analysis: analyzeDag(samplePlan().tasks) },
			runCtx(),
		)) as OptionalStageResult<AiAssessedMetrics>;
		expect(result.kind).toBe("skipped");
	});

	it("is a valid orchestration capability", () => {
		const capability = definePlanningStageCapability(metricsStage(async () => "", metricsRouting));
		expect(capability.manifest.id).toBe("orchestration.metrics");
		expect(capability.manifest.category).toBe("orchestration");
	});
});

describe("combineMetrics → §14 Metrics on the plan", () => {
	it("merges subjective fields with the deterministic parallelism and validates against PlanSchema", async () => {
		const plan = samplePlan();
		const parallelism = computeParallelism(plan.tasks);
		const metrics = combineMetrics(
			{ completeness: 90, confidence: 70, risk: "medium", unknownCount: 2, missingInformation: ["provider"] },
			parallelism,
		);
		expect(metrics.parallelism).toBe(parallelism);

		const withMetrics = { ...plan, metrics };
		expect(Value.Check(PlanSchema, withMetrics)).toBe(true);
	});

	it("persists metrics on the plan via PlanStore", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const plan = samplePlan();
		const metrics = combineMetrics(
			{ completeness: 90, confidence: 70, risk: "low", unknownCount: 1, missingInformation: [] },
			computeParallelism(plan.tasks),
		);
		await store.save({ ...plan, metrics });

		const loaded = await store.load("plan-v");
		expect(Value.Check(PlanSchema, loaded)).toBe(true);
		expect(loaded.metrics).toMatchObject({ completeness: 90, confidence: 70, risk: "low", unknownCount: 1 });
		expect(loaded.metrics!.parallelism).toBe(computeParallelism(plan.tasks));
	});
});
