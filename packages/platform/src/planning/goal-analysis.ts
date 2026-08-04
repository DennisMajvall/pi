/**
 * Goal Analysis stage (§6.3.1) — the first real AI planning stage (Step 2.4).
 *
 * Transforms the user's request into a precise `Goal` (summary, success
 * criteria, unknowns, clarification needs). It is an `orchestration`-category
 * capability producing strict `Goal` JSON against `GoalSchema` (2.1), routed to
 * a purpose-chosen cheap model via `resolveStageModel` (decoupled from the
 * session's selected model), and executed through the §11 strict-JSON runner.
 *
 * Understand only — never plan, decompose, or estimate.
 */

import type { Static } from "typebox";
import { GoalSchema } from "../schema/plan.ts";
import {
	DEFAULT_STAGE_MODEL_ROUTING,
	type PlanningStage,
	requireStageModel,
	resolveStageModel,
	runStrictJsonStage,
	type StageCompletion,
	type StageModelRouting,
} from "./stage.ts";

/** Stage/model-routing key for Goal Analysis (cheap model). */
export const GOAL_ANALYSIS_MODEL_KEY = "goal_analysis";

/** The §6.3.1 exemplar system prompt: understand only. */
export const GOAL_ANALYSIS_SYSTEM_PROMPT =
	"You are Pi's Goal Analysis module. Your only responsibility is understanding " +
	"what the user wants. Do not create a plan. Do not decompose work. Do not " +
	"estimate effort. Only clarify the objective. Return valid JSON matching the " +
	"Goal schema.";

/** Structured inputs the Goal Analysis stage consumes (§6.7 — never the whole conversation). */
export interface GoalAnalysisInput {
	userRequest: string;
	conversation?: string;
	availableCapabilities?: string[];
	userPreferences?: string[];
}

function buildGoalAnalysisPrompt(input: GoalAnalysisInput): string {
	const parts: string[] = ["<user_request>", input.userRequest, "</user_request>"];
	if (input.conversation) {
		parts.push("<conversation>", input.conversation, "</conversation>");
	}
	if (input.availableCapabilities?.length) {
		parts.push("<available_capabilities>", input.availableCapabilities.join(", "), "</available_capabilities>");
	}
	if (input.userPreferences?.length) {
		parts.push("<user_preferences>", input.userPreferences.join(", "), "</user_preferences>");
	}
	return parts.join("\n");
}

/**
 * Build the Goal Analysis `PlanningStage`, injecting the model `completion`
 * (the host binds a real model at 2.12 wiring; tests pass a fake). Model routing
 * resolves the cheap model for `goal_analysis`.
 */
export function goalAnalysisStage(
	completion: StageCompletion,
	routing: StageModelRouting = DEFAULT_STAGE_MODEL_ROUTING,
): PlanningStage<typeof GoalSchema> {
	return {
		id: "orchestration.goal.analysis",
		category: "orchestration",
		name: "Goal Analysis",
		description: "Understand the user's request and formalize it into a Goal (AI, cheap-model routed).",
		systemPrompt: GOAL_ANALYSIS_SYSTEM_PROMPT,
		inputs: ["request", "conversation", "available_capabilities", "user_preferences"],
		outputSchema: GoalSchema,
		mandatory: true,
		modelKey: GOAL_ANALYSIS_MODEL_KEY,
		run: async (input) => {
			const model = requireStageModel(GOAL_ANALYSIS_MODEL_KEY, resolveStageModel(GOAL_ANALYSIS_MODEL_KEY, routing));
			const result = await runStrictJsonStage<typeof GoalSchema>({
				completion,
				systemPrompt: GOAL_ANALYSIS_SYSTEM_PROMPT,
				userPrompt: buildGoalAnalysisPrompt(input as GoalAnalysisInput),
				outputSchema: GoalSchema,
				model,
				mandatory: true,
				stageName: "goal_analysis",
			});
			if (result.kind === "ok") {
				return result.output as Static<typeof GoalSchema>;
			}
			// §11 mandatory stage: abort with the diagnostic.
			throw new Error(result.error);
		},
	};
}
