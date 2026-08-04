/**
 * Plan Critic stage (Architecture §6.3.6) — the adversarial pass (Step 2.9).
 *
 * Tries to destroy the plan: finds missing/duplicate tasks, circular
 * dependencies, incorrect assumptions, risks, and open questions. The critique
 * feeds the Plan Optimizer. It is an **optional** stage (§11) — on repeated
 * validation failure it is skipped, never aborting the pipeline.
 */

import { type Static, Type } from "typebox";
import type { Constraint, Goal, PlanningPolicy, Task } from "../plan/index.ts";
import type { DependencyEdge } from "./dependency-builder.ts";
import {
	DEFAULT_STAGE_MODEL_ROUTING,
	type OptionalStageResult,
	type PlanningStage,
	requireStageModel,
	resolveStageModel,
	runOptionalStage,
	type StageCompletion,
	type StageModelRouting,
} from "./stage.ts";

/** Stage/model-routing key for the Plan Critic. */
export const CRITIC_MODEL_KEY = "critic";

/** §6.3.6 exemplar system prompt: assume mistakes exist; find them. */
export const CRITIC_SYSTEM_PROMPT =
	"You are Pi's adversarial Plan Critic. Assume mistakes exist and find them. " +
	"You are NOT helping create the plan. Identify missing tasks, duplicate tasks, " +
	"circular dependencies, incorrect assumptions, risks, and open questions. " +
	"Return valid JSON matching the Critique schema.";

/** The adversarial critique shape. */
export const CriticSchema = Type.Object(
	{
		missingTasks: Type.Array(Type.String()),
		duplicateTasks: Type.Array(Type.String()),
		circularDependencies: Type.Array(Type.Array(Type.String())),
		incorrectAssumptions: Type.Array(Type.String()),
		risks: Type.Array(Type.String()),
		questions: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

export interface Critique {
	missingTasks: string[];
	duplicateTasks: string[];
	circularDependencies: string[][];
	incorrectAssumptions: string[];
	risks: string[];
	questions: string[];
}

/** Structured input (§6.7): goal, constraints, tasks, dependency edges, policy. */
export interface CriticInput {
	goal: Goal;
	constraints?: Constraint[];
	tasks: Task[];
	edges: DependencyEdge[];
	policy: PlanningPolicy;
}

function buildCriticPrompt(input: CriticInput): string {
	return [
		"<goal>",
		input.goal.summary,
		`success_criteria: ${input.goal.successCriteria.join("; ") || "(none)"}`,
		"</goal>",
		"<tasks>",
		...input.tasks.map((t) => `${t.id}: ${t.title} (-> ${t.deliverable})`),
		"</tasks>",
		"<edges>",
		...input.edges.map((e) => `${e.from} -> ${e.to}`),
		"</edges>",
	].join("\n");
}

/**
 * Build the Plan Critic `PlanningStage`, injecting the model `completion` (host
 * binds a real model at 2.12 wiring; tests pass a fake). Optional (§11): on
 * repeated failure it returns `{ kind: "skipped" }`, never aborts.
 */
export function criticStage(
	completion: StageCompletion,
	routing: StageModelRouting = DEFAULT_STAGE_MODEL_ROUTING,
): PlanningStage<typeof CriticSchema> {
	return {
		id: "orchestration.critic",
		category: "orchestration",
		name: "Plan Critic",
		description: "Adversarial pass that finds missing/duplicate/circular/risky issues in the plan.",
		systemPrompt: CRITIC_SYSTEM_PROMPT,
		inputs: ["goal", "constraints", "tasks", "edges", "policy"],
		outputSchema: CriticSchema,
		mandatory: false,
		modelKey: CRITIC_MODEL_KEY,
		run: async (input) => {
			const model = requireStageModel(CRITIC_MODEL_KEY, resolveStageModel(CRITIC_MODEL_KEY, routing));
			return (await runOptionalStage<typeof CriticSchema>({
				completion,
				systemPrompt: CRITIC_SYSTEM_PROMPT,
				userPrompt: buildCriticPrompt(input as CriticInput),
				outputSchema: CriticSchema,
				model,
				mandatory: false,
				stageName: "critic",
			})) as OptionalStageResult<Static<typeof CriticSchema>>;
		},
	};
}
