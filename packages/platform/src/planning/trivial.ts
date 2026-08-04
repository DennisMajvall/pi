/**
 * The trivial non-AI stage (Step 2.3 walking skeleton).
 *
 * `createDraftPlanStage` (`orchestration.plan.create`) is a deterministic
 * stand-in that establishes the pattern every later stage follows: an
 * `orchestration` capability that runs to produce schema-valid output, persists
 * it through the workspace PlanStore (Step 2.2), and emits a planning event. It
 * turns a goal summary into an empty draft `Plan` and emits `plan.created`.
 */

import type { PlanId } from "../identifier/index.ts";
import { planId } from "../identifier/index.ts";
import type { Plan } from "../plan/index.ts";
import { PlanSchema } from "../schema/plan.ts";
import { planCreatedEvent } from "./events.ts";
import type { PlanningStage } from "./stage.ts";

/**
 * Input accepted by the create-draft-plan stage.
 * `id` is optional; a fresh random plan id is used when omitted.
 */
export interface CreateDraftPlanInput {
	summary: string;
	id?: string;
}

export const createDraftPlanStage: PlanningStage<typeof PlanSchema> = {
	id: "orchestration.plan.create",
	category: "orchestration",
	name: "Create Draft Plan",
	description: "Creates an empty draft plan from a goal summary. Trivial non-AI walking-skeleton stage (Step 2.3).",
	inputs: ["request"],
	outputSchema: PlanSchema,
	mandatory: true,
	run: async (input, ctx) => {
		const { summary, id } = normalizeInput(input);
		const plan = buildDraftPlan(summary, id);
		// Persist first (PlanStore.save validates PlanSchema), then announce.
		await ctx.store.save(plan);
		await ctx.events.emit(planCreatedEvent({ planId: plan.id }));
		return plan;
	},
};

function normalizeInput(input: unknown): { summary: string; id: PlanId } {
	if (typeof input !== "object" || input === null) {
		throw new Error("createDraftPlanStage: input must be an object with a non-empty `summary`");
	}
	const obj = input as { summary?: unknown; id?: unknown };
	const summary = typeof obj.summary === "string" ? obj.summary.trim() : "";
	if (summary.length === 0) {
		throw new Error("createDraftPlanStage: input `summary` must be a non-empty string");
	}
	const id: PlanId = typeof obj.id === "string" && obj.id.length > 0 ? planId(obj.id) : planId();
	return { summary, id };
}

function buildDraftPlan(summary: string, id: PlanId): Plan {
	const now = Date.now();
	return {
		id,
		schemaVersion: 1,
		goal: {
			summary,
			successCriteria: [],
			unknowns: [],
			requiresClarification: false,
			clarificationQuestions: [],
		},
		policy: {
			taskKind: "mixed",
			planningDepth: "medium",
			hierarchicalRefinement: false,
			parallelExecution: true,
			specialistAgents: false,
			requireApproval: true,
			verificationLevel: "basic",
			preferResearch: false,
			maxTasks: 10,
			dualPlanner: false,
		},
		constraints: [],
		assumptions: [],
		tasks: [],
		revisions: [],
		status: "draft",
		createdAt: now,
		updatedAt: now,
	};
}
