/**
 * Plan Optimizer stage (Architecture §6.3.7) + §8 revision helpers (Step 2.9).
 *
 * Improves an already-good plan within intent (never redesign the goal, never
 * remove user intent). It is an **optional** stage (§11) — skipped, never
 * aborted, on repeated failure. On an `ok` result the orchestrator persists the
 * updated plan and records an `optimizer` (or `critic`) revision.
 */

import type { Static } from "typebox";
import { Equal } from "typebox/value";
import type { TaskId } from "../identifier/index.ts";
import { taskId } from "../identifier/index.ts";
import type { Plan, PlanningPolicy, RevisionReason, Task } from "../plan/index.ts";
import { PlanSchema } from "../schema/plan.ts";
import type { Critique } from "./critic.ts";
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

/** Stage/model-routing key for the Plan Optimizer. */
export const OPTIMIZER_MODEL_KEY = "optimizer";

/** §6.3.7 exemplar system prompt: improve within intent. */
export const OPTIMIZER_SYSTEM_PROMPT =
	"You are Pi's Plan Optimizer. Improve an already-good plan. Never redesign the " +
	"goal and never remove user intent: improve efficiency, reduce unnecessary " +
	"work, increase parallelism, and simplify execution. Return valid JSON " +
	"matching the Plan schema (the full updated plan).";

/** Structured input (§6.7): the entire draft plan + critique + policy. */
export interface OptimizerInput {
	plan: Plan;
	critique?: Critique;
	policy: PlanningPolicy;
}

function buildOptimizerPrompt(input: OptimizerInput): string {
	const parts: string[] = ["<plan>", JSON.stringify(input.plan), "</plan>"];
	if (input.critique) {
		parts.push("<critique>", JSON.stringify(input.critique), "</critique>");
	}
	return parts.join("\n");
}

/**
 * Build the Plan Optimizer `PlanningStage`, injecting the model `completion`
 * (host binds a real model at 2.12 wiring; tests pass a fake). Optional (§11).
 */
export function optimizerStage(
	completion: StageCompletion,
	routing: StageModelRouting = DEFAULT_STAGE_MODEL_ROUTING,
): PlanningStage<typeof PlanSchema> {
	return {
		id: "orchestration.optimizer",
		category: "orchestration",
		name: "Plan Optimizer",
		description: "Improve an already-good plan within intent, returning the updated plan.",
		systemPrompt: OPTIMIZER_SYSTEM_PROMPT,
		inputs: ["plan", "critique", "policy"],
		outputSchema: PlanSchema,
		mandatory: false,
		modelKey: OPTIMIZER_MODEL_KEY,
		run: async (input) => {
			const model = requireStageModel(OPTIMIZER_MODEL_KEY, resolveStageModel(OPTIMIZER_MODEL_KEY, routing));
			return (await runOptionalStage<typeof PlanSchema>({
				completion,
				systemPrompt: OPTIMIZER_SYSTEM_PROMPT,
				userPrompt: buildOptimizerPrompt(input as OptimizerInput),
				outputSchema: PlanSchema,
				model,
				mandatory: false,
				stageName: "optimizer",
			})) as OptionalStageResult<Static<typeof PlanSchema>>;
		},
	};
}

/**
 * Diff two task lists by id then deep equality. Returns task ids that were
 * added, removed, or modified between `before` and `after`.
 */
export function changedTaskIds(before: Task[], after: Task[]): TaskId[] {
	const changed = new Set<string>();
	const afterById = new Map<string, Task>();
	for (const task of after) {
		afterById.set(String(task.id), task);
	}
	const beforeById = new Map<string, Task>();
	for (const task of before) {
		beforeById.set(String(task.id), task);
	}
	for (const task of after) {
		const prior = beforeById.get(String(task.id));
		if (!prior || !Equal(prior, task)) {
			changed.add(String(task.id));
		}
	}
	for (const task of before) {
		if (!afterById.has(String(task.id))) {
			changed.add(String(task.id));
		}
	}
	return [...changed].map((id) => taskId(id));
}

/**
 * Append a `critic`/`optimizer` revision with the next `version` and a refreshed
 * `updatedAt`, returning the updated plan (schema-preserving). The orchestrator
 * re-stores the whole document via the 2.2 PlanStore (§8 full-document rule).
 */
export function appendRevision(
	plan: Plan,
	reason: Extract<RevisionReason, "critic" | "optimizer">,
	changeIds: TaskId[],
): Plan {
	const version = plan.revisions.length > 0 ? plan.revisions[plan.revisions.length - 1]!.version + 1 : 1;
	return {
		...plan,
		revisions: [...plan.revisions, { version, reason, changedTaskIds: changeIds, createdAt: Date.now() }],
		updatedAt: Date.now(),
	};
}
