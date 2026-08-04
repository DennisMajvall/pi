/**
 * Task Decomposition stage (§6.3.4) — break the goal into the smallest
 * meaningful tasks as an unordered list (Step 2.7).
 *
 * The stage emits `{ id, title, purpose, deliverable }` tuples only — no
 * ordering, no priorities, no dependencies, no parallelism (enforced by
 * `additionalProperties: false`, so a stage output can never carry planning or
 * execution fields). A deterministic dedupe + `maxTasks` budget pass follows.
 * Mandatory per §11.
 */

import { type Static, Type } from "typebox";
import type { Constraint, Goal, PlanningPolicy } from "../plan/index.ts";
import {
	DEFAULT_STAGE_MODEL_ROUTING,
	type PlanningStage,
	requireStageModel,
	resolveStageModel,
	runStrictJsonStage,
	type StageCompletion,
	type StageModelRouting,
} from "./stage.ts";

/** Stage/model-routing key for Task Decomposition. */
export const TASK_DECOMPOSITION_MODEL_KEY = "task_decomposition";

/** §6.3.4 exemplar system prompt: identify work that must exist, nothing else. */
export const TASK_DECOMPOSITION_SYSTEM_PROMPT =
	"You are Pi's Task Decomposition module. Break the goal into the smallest " +
	"meaningful tasks. Never think about execution, scheduling, ordering, or " +
	"optimization — only identify work that must exist. Do not add dependencies " +
	"or priorities. Stay within the max tasks budget. Return valid JSON matching " +
	"the TaskDecomposition schema.";

/** A single decomposed task tuple (no deps/priority/execution fields). */
export const DecomposedTaskSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		title: Type.String(),
		purpose: Type.String(),
		deliverable: Type.String(),
	},
	{ additionalProperties: false, description: "Unordered, unprioritized task (§6.3.4)" },
);

/** Strict output schema: an unordered task list. */
export const TaskDecompositionSchema = Type.Object(
	{
		tasks: Type.Array(DecomposedTaskSchema),
	},
	{ additionalProperties: false },
);

/** Structured input (§6.7): goal, constraints, policy (for maxTasks), capabilities, skills. */
export interface TaskDecompositionInput {
	goal: Goal;
	constraints?: Constraint[];
	policy: PlanningPolicy;
	availableCapabilities?: string[];
	skills?: string[];
}

function buildTaskPrompt(input: TaskDecompositionInput): string {
	const parts: string[] = [
		"<goal>",
		input.goal.summary,
		`success_criteria: ${input.goal.successCriteria.join("; ") || "(none)"}`,
		"</goal>",
		`<max_tasks>${input.policy.maxTasks}</max_tasks>`,
	];
	if (input.constraints?.length) {
		parts.push(
			"<constraints>",
			input.constraints.map((c) => `${c.kind} ${c.description}`).join("\n"),
			"</constraints>",
		);
	}
	if (input.availableCapabilities?.length) {
		parts.push(`<available_capabilities>${input.availableCapabilities.join(", ")}</available_capabilities>`);
	}
	if (input.skills?.length) {
		parts.push(`<skills>${input.skills.join(", ")}</skills>`);
	}
	return parts.join("\n");
}

/**
 * Build the Task Decomposition `PlanningStage`, injecting the model `completion`
 * (host binds a real model at 2.12 wiring; tests pass a fake).
 */
export function taskDecompositionStage(
	completion: StageCompletion,
	routing: StageModelRouting = DEFAULT_STAGE_MODEL_ROUTING,
): PlanningStage<typeof TaskDecompositionSchema> {
	return {
		id: "orchestration.tasks",
		category: "orchestration",
		name: "Task Decomposition",
		description: "Break the goal into the smallest meaningful unordered tasks.",
		systemPrompt: TASK_DECOMPOSITION_SYSTEM_PROMPT,
		inputs: ["goal", "constraints", "policy", "capabilities", "skills"],
		outputSchema: TaskDecompositionSchema,
		mandatory: true,
		modelKey: TASK_DECOMPOSITION_MODEL_KEY,
		run: async (input) => {
			const model = requireStageModel(
				TASK_DECOMPOSITION_MODEL_KEY,
				resolveStageModel(TASK_DECOMPOSITION_MODEL_KEY, routing),
			);
			const result = await runStrictJsonStage<typeof TaskDecompositionSchema>({
				completion,
				systemPrompt: TASK_DECOMPOSITION_SYSTEM_PROMPT,
				userPrompt: buildTaskPrompt(input as TaskDecompositionInput),
				outputSchema: TaskDecompositionSchema,
				model,
				mandatory: true,
				stageName: "task_decomposition",
			});
			if (result.kind === "ok") {
				return result.output as Static<typeof TaskDecompositionSchema>;
			}
			throw new Error(result.error);
		},
	};
}
