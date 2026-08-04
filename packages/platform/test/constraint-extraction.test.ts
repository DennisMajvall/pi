/**
 * Tests for Constraint Extraction (Step 2.6): the AI stage emits the four
 * constraint families, the deterministic fold maps them onto `Plan.constraints`,
 * and the policy-downgrade rule caps/forces policy fields but never upgrades.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { planId } from "../src/identifier/index.ts";
import { PlanStore } from "../src/kernel/plan-store.ts";
import type { Constraint, Goal, Plan, PlanningPolicy } from "../src/plan/index.ts";
import {
	applyConstraintDowngrade,
	CONSTRAINT_EXTRACTION_MODEL_KEY,
	ConstraintExtractionSchema,
	type ConstraintFamilies,
	constraintExtractionStage,
	foldConstraints,
	type PlanningStageRunContext,
	policyDowngradeFromConstraints,
	type StageCompletion,
	type StageModelRouting,
} from "../src/planning/index.ts";
import { definePlanningStageCapability } from "../src/planning/stage.ts";
import { PlanSchema } from "../src/schema/plan.ts";

const tempDirs: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-platform-constraints-"));
	tempDirs.push(root);
	return root;
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

const routing: StageModelRouting = {
	default: "capable-1",
	stages: { [CONSTRAINT_EXTRACTION_MODEL_KEY]: "capable-1" },
};

function sampleGoal(): Goal {
	return {
		summary: "Ship the billing feature",
		successCriteria: ["Invoices generate on schedule"],
		unknowns: [],
		requiresClarification: false,
		clarificationQuestions: [],
	};
}

function sampleFamilies(): ConstraintFamilies {
	return {
		hardConstraints: ["Must ship within 3 days", "Must be reviewed before deploy"],
		softConstraints: ["Prefer minimal config churn"],
		resourceConstraints: ["No budget for additional compute"],
		policyConstraints: ["Signing keys stay in the secrets store"],
	};
}

function samplePolicy(): PlanningPolicy {
	return {
		taskKind: "implementation",
		planningDepth: "high",
		hierarchicalRefinement: true,
		parallelExecution: true,
		specialistAgents: true,
		requireApproval: false,
		verificationLevel: "strict",
		preferResearch: false,
		maxTasks: 12,
		dualPlanner: true,
	};
}

function capturingCompletion(models: string[], families: ConstraintFamilies): StageCompletion {
	return async ({ model }) => {
		models.push(model);
		return JSON.stringify(families);
	};
}

function runCtx(): PlanningStageRunContext {
	return {} as unknown as PlanningStageRunContext;
}

describe("Constraint Extraction stage", () => {
	it("returns the four families validating against ConstraintExtractionSchema", async () => {
		const models: string[] = [];
		const stage = constraintExtractionStage(capturingCompletion(models, sampleFamilies()), routing);
		const output = (await stage.run({ goal: sampleGoal() }, runCtx())) as ConstraintFamilies;
		expect(Value.Check(ConstraintExtractionSchema, output)).toBe(true);
		expect(models).toEqual(["capable-1"]);
	});

	it("aborts (§11 mandatory) on persistent invalid output", async () => {
		const stage = constraintExtractionStage(async () => JSON.stringify({ hardConstraints: 42 }), routing);
		await expect(stage.run({ goal: sampleGoal() }, runCtx())).rejects.toThrow("constraint_extraction");
	});

	it("is a valid orchestration capability", () => {
		const capability = definePlanningStageCapability(
			constraintExtractionStage(capturingCompletion([], sampleFamilies())),
		);
		expect(capability.manifest.id).toBe("orchestration.constraints");
		expect(capability.manifest.category).toBe("orchestration");
	});
});

describe("fold + policy downgrade rule", () => {
	it("folds the four families onto Plan.constraints with the right kinds", () => {
		expect(foldConstraints(sampleFamilies())).toEqual([
			{ kind: "hard", description: "Must ship within 3 days" },
			{ kind: "hard", description: "Must be reviewed before deploy" },
			{ kind: "soft", description: "Prefer minimal config churn" },
			{ kind: "resource", description: "No budget for additional compute" },
			{ kind: "policy", description: "Signing keys stay in the secrets store" },
		]);
	});

	it("downgrades: hard time limit caps depth, resource budget disables specialists/dual", () => {
		const policy = samplePolicy();
		const constraints: Constraint[] = foldConstraints(sampleFamilies());
		const downgraded = applyConstraintDowngrade(policy, constraints);
		expect(downgraded.planningDepth).toBe("medium"); // capped by time limit
		expect(downgraded.specialistAgents).toBe(false); // no budget
		expect(downgraded.dualPlanner).toBe(false); // no budget
		expect(downgraded.requireApproval).toBe(true); // hard review constraint
	});

	it("disables parallelism on a resource/parallel constraint", () => {
		const constraints: Constraint[] = [{ kind: "hard", description: "One task at a time" }];
		expect(policyDowngradeFromConstraints(constraints)).toMatchObject({ parallelExecution: false });
	});

	it("never upgrades: soft/policy constraints and already-stricter settings are ignored", () => {
		const strict: PlanningPolicy = { ...samplePolicy(), planningDepth: "low", parallelExecution: false };
		const constraints: Constraint[] = [{ kind: "soft", description: "Prefer high depth if cheap" }];
		const downgraded = applyConstraintDowngrade(strict, constraints);
		expect(downgraded.planningDepth).toBe("low"); // not upgraded to medium
		expect(downgraded.parallelExecution).toBe(false);
	});

	it("stores the folded constraints + downgraded policy on a plan via PlanStore", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const plan: Plan = {
			id: planId("plan-c"),
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
		const constraints = foldConstraints(sampleFamilies());
		plan.constraints = constraints;
		plan.policy = applyConstraintDowngrade(plan.policy, constraints);
		await store.save(plan);

		expect(Value.Check(PlanSchema, plan)).toBe(true);
		const loaded = await store.load("plan-c");
		expect(loaded.constraints).toHaveLength(5);
		expect(loaded.policy.planningDepth).toBe("medium");
	});
});
