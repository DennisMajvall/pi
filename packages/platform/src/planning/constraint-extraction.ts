/**
 * Constraint Extraction stage (§6.3.3) — collects every limitation that should
 * influence planning (Step 2.6).
 *
 * An `orchestration` capability that produces the four constraint families
 * (`hard` / `soft` / `resource` / `policy`) as strict JSON against
 * `ConstraintExtractionSchema`, which the deterministic fold (`foldConstraints`)
 * turns into `Plan.constraints`. Executed through the §11 runner with per-stage
 * model routing.
 */

import { type Static, Type } from "typebox";
import type { Goal } from "../plan/index.ts";
import {
	DEFAULT_STAGE_MODEL_ROUTING,
	type PlanningStage,
	requireStageModel,
	resolveStageModel,
	runStrictJsonStage,
	type StageCompletion,
	type StageModelRouting,
} from "./stage.ts";

/** Stage/model-routing key for Constraint Extraction. */
export const CONSTRAINT_EXTRACTION_MODEL_KEY = "constraint_extraction";

/** §6.3.3 exemplar system prompt: extract limitations, do not plan. */
export const CONSTRAINT_EXTRACTION_SYSTEM_PROMPT =
	"You are Pi's Constraint Extraction module. Extract every limitation that should " +
	"influence planning: hard constraints, soft constraints, resource constraints, " +
	"and policy constraints. Use the runtime context alongside the goal. Do not " +
	"plan, decompose, or estimate. Return valid JSON matching the ConstraintExtraction schema.";

/** Strict four-family output schema. */
export const ConstraintExtractionSchema = Type.Object(
	{
		hardConstraints: Type.Array(Type.String()),
		softConstraints: Type.Array(Type.String()),
		resourceConstraints: Type.Array(Type.String()),
		policyConstraints: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

/** Runtime context a constraint extraction can lean on. */
export interface RuntimeConstraintContext {
	os?: string;
	installedSoftware?: string[];
	availableTools?: string[];
	modelLimits?: string[];
	timeLimit?: string;
	permissions?: string[];
}

/** Structured input: Goal Analysis output plus runtime context. */
export interface ConstraintExtractionInput {
	goal: Goal;
	runtime?: RuntimeConstraintContext;
}

function buildConstraintPrompt(input: ConstraintExtractionInput): string {
	const parts: string[] = [
		"<goal>",
		input.goal.summary,
		`success_criteria: ${input.goal.successCriteria.join("; ") || "(none)"}`,
		"</goal>",
	];
	const runtime = input.runtime;
	if (runtime) {
		parts.push("<runtime>");
		if (runtime.os) parts.push(`os: ${runtime.os}`);
		if (runtime.installedSoftware?.length) parts.push(`installed: ${runtime.installedSoftware.join(", ")}`);
		if (runtime.availableTools?.length) parts.push(`tools: ${runtime.availableTools.join(", ")}`);
		if (runtime.modelLimits?.length) parts.push(`model limits: ${runtime.modelLimits.join(", ")}`);
		if (runtime.timeLimit) parts.push(`time limit: ${runtime.timeLimit}`);
		if (runtime.permissions?.length) parts.push(`permissions: ${runtime.permissions.join(", ")}`);
		parts.push("</runtime>");
	}
	return parts.join("\n");
}

/**
 * Build the Constraint Extraction `PlanningStage`, injecting the model
 * `completion` (host binds a real model at 2.12 wiring; tests pass a fake).
 */
export function constraintExtractionStage(
	completion: StageCompletion,
	routing: StageModelRouting = DEFAULT_STAGE_MODEL_ROUTING,
): PlanningStage<typeof ConstraintExtractionSchema> {
	return {
		id: "orchestration.constraints",
		category: "orchestration",
		name: "Constraint Extraction",
		description: "Extract hard/soft/resource/policy constraints from the goal and runtime context.",
		systemPrompt: CONSTRAINT_EXTRACTION_SYSTEM_PROMPT,
		inputs: ["goal", "runtime"],
		outputSchema: ConstraintExtractionSchema,
		mandatory: true,
		modelKey: CONSTRAINT_EXTRACTION_MODEL_KEY,
		run: async (input) => {
			const model = requireStageModel(
				CONSTRAINT_EXTRACTION_MODEL_KEY,
				resolveStageModel(CONSTRAINT_EXTRACTION_MODEL_KEY, routing),
			);
			const result = await runStrictJsonStage<typeof ConstraintExtractionSchema>({
				completion,
				systemPrompt: CONSTRAINT_EXTRACTION_SYSTEM_PROMPT,
				userPrompt: buildConstraintPrompt(input as ConstraintExtractionInput),
				outputSchema: ConstraintExtractionSchema,
				model,
				mandatory: true,
				stageName: "constraint_extraction",
			});
			if (result.kind === "ok") {
				return result.output as Static<typeof ConstraintExtractionSchema>;
			}
			throw new Error(result.error);
		},
	};
}
