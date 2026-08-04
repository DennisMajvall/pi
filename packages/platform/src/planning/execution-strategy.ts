/**
 * Execution Strategy Selection (Architecture §7) — the single highest-leverage
 * stage (Step 2.5).
 *
 * Right after Goal Analysis it decides *how planning itself should behave* for
 * the request and emits the `PlanningPolicy` (2.1) — one policy consumed by
 * every downstream stage, so depth/parallelism/approval/dual-planner decisions
 * are made once instead of being re-derived inconsistently per stage.
 *
 * An `orchestration` capability producing strict `PlanningPolicy` JSON against
 * `PlanningPolicySchema`, executed through the §11 runner, with per-stage model
 * routing. Output is stored on the plan (`plan.policy`) and threaded into every
 * later stage's input set (§6.6).
 */

import type { Static } from "typebox";
import type { Constraint, Goal } from "../plan/index.ts";
import { PlanningPolicySchema } from "../schema/plan.ts";
import {
	DEFAULT_STAGE_MODEL_ROUTING,
	type PlanningStage,
	requireStageModel,
	resolveStageModel,
	runStrictJsonStage,
	type StageCompletion,
	type StageModelRouting,
} from "./stage.ts";

/** Stage/model-routing key for Execution Strategy Selection. */
export const EXECUTION_STRATEGY_MODEL_KEY = "execution_strategy";

/** §6.3.2 exemplar system prompt: decide how to plan, not what to do. */
export const EXECUTION_STRATEGY_SYSTEM_PROMPT =
	"You are Pi's Execution Strategy Selection module. Decide how planning itself " +
	"should behave for this request: task kind, planning depth, hierarchical " +
	"refinement, parallelism, specialist agents, approval, verification level, " +
	"research preference, max tasks, and dual planning. Do not plan the work " +
	"itself, do not decompose tasks. Return valid JSON matching the PlanningPolicy schema.";

/** Structured input: the Goal Analysis output (plus any extracted constraints). */
export interface ExecutionStrategyInput {
	goal: Goal;
	constraints?: Constraint[];
}

function buildStrategyPrompt(input: ExecutionStrategyInput): string {
	const parts: string[] = [
		"<goal>",
		`summary: ${input.goal.summary}`,
		`success_criteria: ${input.goal.successCriteria.join("; ") || "(none)"}`,
		`unknowns: ${input.goal.unknowns.join("; ") || "(none)"}`,
		"</goal>",
	];
	if (input.constraints?.length) {
		parts.push(
			"<constraints>",
			input.constraints.map((c) => `${c.kind}: ${c.description}`).join("\n"),
			"</constraints>",
		);
	}
	return parts.join("\n");
}

/**
 * Build the Execution Strategy `PlanningStage`, injecting the model `completion`
 * (host binds a real model at 2.12 wiring; tests pass a fake).
 */
export function executionStrategyStage(
	completion: StageCompletion,
	routing: StageModelRouting = DEFAULT_STAGE_MODEL_ROUTING,
): PlanningStage<typeof PlanningPolicySchema> {
	return {
		id: "orchestration.strategy",
		category: "orchestration",
		name: "Execution Strategy Selection",
		description: "Decide how planning itself should behave for the request, emitting the PlanningPolicy.",
		systemPrompt: EXECUTION_STRATEGY_SYSTEM_PROMPT,
		inputs: ["goal", "constraints"],
		outputSchema: PlanningPolicySchema,
		mandatory: true,
		modelKey: EXECUTION_STRATEGY_MODEL_KEY,
		run: async (input) => {
			const model = requireStageModel(
				EXECUTION_STRATEGY_MODEL_KEY,
				resolveStageModel(EXECUTION_STRATEGY_MODEL_KEY, routing),
			);
			const result = await runStrictJsonStage<typeof PlanningPolicySchema>({
				completion,
				systemPrompt: EXECUTION_STRATEGY_SYSTEM_PROMPT,
				userPrompt: buildStrategyPrompt(input as ExecutionStrategyInput),
				outputSchema: PlanningPolicySchema,
				model,
				mandatory: true,
				stageName: "execution_strategy",
			});
			if (result.kind === "ok") {
				return result.output as Static<typeof PlanningPolicySchema>;
			}
			throw new Error(result.error);
		},
	};
}
