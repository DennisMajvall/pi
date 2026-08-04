/**
 * Tests for Execution Strategy Selection (Step 2.5): the AI stage produces a
 * strict `PlanningPolicy` (stored on the plan), aborts under §11 on persistent
 * invalid output, and the deterministic policy guard hook never upgrades.
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
	downgradePolicy,
	EXECUTION_STRATEGY_MODEL_KEY,
	executionStrategyStage,
	type PlanningStageRunContext,
	requireStageModel,
	type StageCompletion,
	type StageModelRouting,
} from "../src/planning/index.ts";
import { definePlanningStageCapability } from "../src/planning/stage.ts";
import { PlanningPolicySchema, PlanSchema } from "../src/schema/plan.ts";

const tempDirs: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-platform-strategy-"));
	tempDirs.push(root);
	return root;
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

const routing: StageModelRouting = { default: "capable-1", stages: { [EXECUTION_STRATEGY_MODEL_KEY]: "capable-1" } };

function samplePolicy(): PlanningPolicy {
	return {
		taskKind: "implementation",
		planningDepth: "high",
		hierarchicalRefinement: true,
		parallelExecution: true,
		specialistAgents: false,
		requireApproval: true,
		verificationLevel: "strict",
		preferResearch: false,
		maxTasks: 12,
		dualPlanner: true,
	};
}

function sampleGoal(): Goal {
	return {
		summary: "Ship the billing feature",
		successCriteria: ["Invoices generate on schedule"],
		unknowns: [],
		requiresClarification: false,
		clarificationQuestions: [],
	};
}

function draftPlan(id: string): Plan {
	return {
		id: planId(id),
		schemaVersion: 1,
		goal: sampleGoal(),
		policy: samplePolicy(),
		constraints: [],
		assumptions: [],
		tasks: [],
		revisions: [],
		status: "draft",
		createdAt: 1,
		updatedAt: 1,
	};
}

function capturingCompletion(models: string[], policy: PlanningPolicy): StageCompletion {
	return async ({ model }) => {
		models.push(model);
		return JSON.stringify(policy);
	};
}

function runCtx(): PlanningStageRunContext {
	return {} as unknown as PlanningStageRunContext;
}

describe("Execution Strategy Selection stage", () => {
	it("produces a schema-valid PlanningPolicy on the routed model", async () => {
		const models: string[] = [];
		const stage = executionStrategyStage(capturingCompletion(models, samplePolicy()), routing);
		const output = (await stage.run({ goal: sampleGoal() }, runCtx())) as PlanningPolicy;
		expect(Value.Check(PlanningPolicySchema, output)).toBe(true);
		expect(models).toEqual(["capable-1"]);
	});

	it("aborts (§11 mandatory) when the completion never returns valid PlanningPolicy JSON", async () => {
		const stage = executionStrategyStage(async () => JSON.stringify({ planningDepth: 42 }), routing);
		await expect(stage.run({ goal: sampleGoal() }, runCtx())).rejects.toThrow("execution_strategy");
	});

	it("is a valid orchestration stage", () => {
		const capability = definePlanningStageCapability(executionStrategyStage(capturingCompletion([], samplePolicy())));
		expect(capability.manifest.id).toBe("orchestration.strategy");
		expect(capability.manifest.category).toBe("orchestration");
	});

	it("policy output stores on a plan and round-trips against PlanSchema", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const plan = draftPlan("plan-s");
		const stage = executionStrategyStage(capturingCompletion([], samplePolicy()), routing);
		const policy = (await stage.run({ goal: sampleGoal() }, runCtx())) as PlanningPolicy;

		// Store the produced policy on the plan and persist.
		plan.policy = policy;
		await store.save(plan);
		expect(Value.Check(PlanSchema, plan)).toBe(true);
		expect((await store.load("plan-s")).policy).toEqual(policy);
	});
});

describe("policy guard hook (§7) — deterministic, never upgrades", () => {
	it("caps planningDepth downward", () => {
		expect(downgradePolicy(samplePolicy(), { planningDepth: "medium" }).planningDepth).toBe("medium");
		expect(
			downgradePolicy({ ...samplePolicy(), planningDepth: "low" }, { planningDepth: "medium" }).planningDepth,
		).toBe("low");
	});

	it("disables parallelism and dual planning, forces approval", () => {
		const downgraded = downgradePolicy(samplePolicy(), {
			parallelExecution: false,
			dualPlanner: false,
			requireApproval: true,
		});
		expect(downgraded.parallelExecution).toBe(false);
		expect(downgraded.dualPlanner).toBe(false);
		expect(downgraded.requireApproval).toBe(true);
	});

	it("never relaxes a field (an irrelevant downgrade is ignored)", () => {
		const strict = { ...samplePolicy(), parallelExecution: false, requireApproval: true };
		const downgraded = downgradePolicy(strict, { planningDepth: "high" });
		expect(downgraded.parallelExecution).toBe(false);
		expect(downgraded.requireApproval).toBe(true);
	});

	it("requireStageModel binds the guard to the AI stage routing", () => {
		expect(requireStageModel(EXECUTION_STRATEGY_MODEL_KEY, "capable-1")).toBe("capable-1");
		expect(() => requireStageModel(EXECUTION_STRATEGY_MODEL_KEY, "")).toThrow(/no model configured/);
	});
});
