/**
 * Tests for Goal Analysis + the Clarification Gate (Step 2.4): the AI stage
 * produces strict `Goal` JSON on a purpose-chosen cheap model (decoupled from
 * the session model), aborts under §11 on persistent invalid output, and the
 * deterministic gate pauses / loops / proceeds within its bound.
 */

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { Goal } from "../src/plan/index.ts";
import { runClarificationGate } from "../src/planning/clarification-gate.ts";
import {
	GOAL_ANALYSIS_MODEL_KEY,
	goalAnalysisStage,
	type PlanningStageRunContext,
	requireStageModel,
	runStrictJsonStage,
	type StageCompletion,
	type StageModelRouting,
	stageModelRoutingFromSettings,
} from "../src/planning/index.ts";
import { definePlanningStageCapability } from "../src/planning/stage.ts";
import { GoalSchema } from "../src/schema/plan.ts";

/** The goal-analysis stage run() ignores the context (no store/events needed). */
function runCtx(): PlanningStageRunContext {
	return {} as unknown as PlanningStageRunContext;
}

/** A completion that inspects the requested model and returns the given Goal JSON. */
function goalCompletion(modelCaptured: string[], goal: Goal): StageCompletion {
	return async ({ model }) => {
		modelCaptured.push(model);
		return JSON.stringify(goal);
	};
}

function sampleGoal(overrides: Partial<Goal> = {}): Goal {
	return {
		summary: "Ship the billing feature",
		successCriteria: ["Invoices generate on schedule", "Customers can pay by card"],
		unknowns: ["Payment provider downtime SLA"],
		requiresClarification: false,
		clarificationQuestions: [],
		...overrides,
	};
}

const cheapRouting: StageModelRouting = { default: "capable-1", stages: { [GOAL_ANALYSIS_MODEL_KEY]: "cheap-1" } };

describe("Goal Analysis stage", () => {
	it("produces a schema-valid Goal on the cheap model", async () => {
		const models: string[] = [];
		const stage = goalAnalysisStage(goalCompletion(models, sampleGoal()), cheapRouting);
		const output = (await stage.run({ userRequest: "Ship the billing feature" }, runCtx())) as Goal;
		expect(Value.Check(GoalSchema, output)).toBe(true);
		expect(output.summary).toBe("Ship the billing feature");
		// Routed to the purpose-chosen cheap model, not the session model.
		expect(models).toEqual(["cheap-1"]);
	});

	it("aborts (§11 mandatory) when the completion never returns valid Goal JSON", async () => {
		const stage = goalAnalysisStage(async () => JSON.stringify({ summary: 42 }), cheapRouting);
		const run = stage.run({ userRequest: "x" }, runCtx());
		await expect(run).rejects.toThrow("goal_analysis");
	});

	it("is a valid orchestration stage (wrappable as a capability)", () => {
		const capability = definePlanningStageCapability(goalAnalysisStage(goalCompletion([], sampleGoal())));
		expect(capability.manifest.category).toBe("orchestration");
		expect(capability.manifest.id).toBe("orchestration.goal.analysis");
		expect(capability.manifest.provides.orchestration?.name).toBe("Goal Analysis");
	});

	it("refuses to run when no model is configured", async () => {
		// No routing → resolves to the empty placeholder → must fail loudly.
		const stage = goalAnalysisStage(goalCompletion([], sampleGoal()));
		await expect(stage.run({ userRequest: "x" }, runCtx())).rejects.toThrow(/no model configured/);
	});
});

describe("model routing resolves from settings", () => {
	it("builds stage routing from a settings mapping", () => {
		const routing = stageModelRoutingFromSettings({
			default: "capable-1",
			stages: { [GOAL_ANALYSIS_MODEL_KEY]: "cheap-1" },
		});
		expect(routing).toEqual({ default: "capable-1", stages: { goal_analysis: "cheap-1" } });
	});

	it("requireStageModel rejects an unconfigured (empty) model loudly", () => {
		expect(() => requireStageModel(GOAL_ANALYSIS_MODEL_KEY, "")).toThrow(/no model configured/);
	});
});

describe("Clarification Gate (§9) — deterministic", () => {
	it("is clear when no clarification is needed", () => {
		expect(runClarificationGate(sampleGoal(), { roundsUsed: 0 })).toEqual({ kind: "clear" });
	});

	it("surfaces the blocking questions within the bound", () => {
		const goal = sampleGoal({
			requiresClarification: true,
			clarificationQuestions: [
				{ question: "Which payment providers?", blocking: true },
				{ question: "Support refunds?", blocking: false },
			],
		});
		expect(runClarificationGate(goal, { roundsUsed: 0 })).toEqual({
			kind: "needs_clarification",
			questions: goal.clarificationQuestions,
		});
	});

	it("proceeds with low-confidence assumptions when the bound is exceeded", () => {
		const goal = sampleGoal({
			requiresClarification: true,
			clarificationQuestions: [{ question: "Which payment providers?", blocking: true }],
		});
		const result = runClarificationGate(goal, { roundsUsed: 2, maxRounds: 2 });
		expect(result.kind).toBe("proceed_with_unknowns");
		if (result.kind === "proceed_with_unknowns") {
			expect(result.assumptions).toEqual([
				{
					statement: "Assumed from unresolved unknown: Payment provider downtime SLA",
					confidence: 40,
					source: "inferred",
				},
			]);
		}
	});

	it("is clear after the user's answers resolve the clarification", () => {
		// First pass: gate needs clarification.
		const goal = sampleGoal({
			requiresClarification: true,
			clarificationQuestions: [{ question: "Which payment providers?", blocking: true }],
		});
		expect(runClarificationGate(goal, { roundsUsed: 0 }).kind).toBe("needs_clarification");

		// Re-run Goal Analysis with the answers → goal no longer needs clarification.
		const resolved = runClarificationGate(sampleGoal(), { roundsUsed: 1 });
		expect(resolved).toEqual({ kind: "clear" });
	});
});

describe("strict-JSON runner interaction with Goal outputSchema", () => {
	it("validates Goal JSON via the shared runner (retry-then-ok)", async () => {
		let count = 0;
		const completion: StageCompletion = async () => {
			count++;
			return count === 1 ? JSON.stringify({ summary: "x" }) : JSON.stringify(sampleGoal());
		};
		const result = await runStrictJsonStage<typeof GoalSchema>({
			completion,
			systemPrompt: "sys",
			userPrompt: "user",
			outputSchema: GoalSchema,
			model: "cheap-1",
			mandatory: true,
		});
		expect(result).toMatchObject({ kind: "ok", attempts: 2 });
	});
});
