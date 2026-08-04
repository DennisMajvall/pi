/**
 * User Review / approval gate (§6.3.10, Step 2.11).
 *
 * The deterministic human gate before execution. The strategy stage sets
 * `policy.requireApproval` (default `true` for `planningDepth ≥ medium`); the
 * gate honors it. Approval is a deterministic state transition, never an AI
 * decision:
 *
 * - `evaluateReviewGate(plan)` decides whether the gate applies for this plan:
 *   `required` when the policy asks for approval, `auto_approved` otherwise
 *   (an unapproved-plan policy skips the gate).
 * - `requestReview(plan)` moves a finished `draft` to `needs_review`.
 * - `approvePlan(plan)` flips `needs_review → approved` and records an
 *   `approval` revision (§8) — the explicit human approval.
 * - `autoApprovePlan(plan)` flips `draft|needs_review → approved` for policies
 *   that do not require approval.
 *
 * All transitions are pure (return a new plan); the caller persists via the
 * PlanStore. `reviewGateStage` wraps the flow as an `orchestration` capability
 * (load → transition → save → emit `plan.approved`).
 */

import type { TaskId } from "../identifier/index.ts";
import type { Plan, PlanStatus, RevisionReason } from "../plan/index.ts";
import { PlanSchema } from "../schema/plan.ts";
import { planApprovedEvent } from "./events.ts";
import type { PlanningStage } from "./stage.ts";

/** The deterministic gate decision for a plan (§6.3.10). */
export type ReviewGateDecision = { kind: "required" } | { kind: "auto_approved"; reason: string };

/** Whether the human approval gate applies to a plan. */
export function evaluateReviewGate(plan: Plan): ReviewGateDecision {
	if (plan.policy.requireApproval) {
		return { kind: "required" };
	}
	return {
		kind: "auto_approved",
		reason: "policy.requireApproval is false; approval gate skipped",
	};
}

/** Next revision version number (§8: monotonically increasing, starts at 1). */
export function nextPlanVersion(plan: Plan): number {
	return plan.revisions.length > 0 ? plan.revisions[plan.revisions.length - 1]!.version + 1 : 1;
}

/**
 * Append a revision and refresh `updatedAt`, returning a new plan
 * (schema-preserving). Shared by the approval and user-edit transitions.
 */
export function appendPlanRevision(plan: Plan, reason: RevisionReason, changedTaskIds: TaskId[]): Plan {
	return {
		...plan,
		revisions: [...plan.revisions, { version: nextPlanVersion(plan), reason, changedTaskIds, createdAt: Date.now() }],
		updatedAt: Date.now(),
	};
}

const REVIEWABLE: readonly PlanStatus[] = ["draft", "needs_review"];

function assertReviewable(plan: Plan, action: string): void {
	if (!REVIEWABLE.includes(plan.status)) {
		throw new Error(`cannot ${action} a plan in status "${plan.status}"; expected ${REVIEWABLE.join(" or ")}`);
	}
}

/**
 * Move a finished `draft` into `needs_review` (the pipeline's last content
 * transition; no revision — review changes no tasks). Idempotent for a plan
 * already in `needs_review`.
 */
export function requestReview(plan: Plan): Plan {
	assertReviewable(plan, "request review for");
	if (plan.status === "needs_review") {
		return plan;
	}
	return { ...plan, status: "needs_review", updatedAt: Date.now() };
}

/**
 * The explicit human approval: `needs_review → approved`, recording an
 * `approval` revision (§8). Throws unless the plan is `needs_review` — the
 * gate is only satisfied for a reviewed plan.
 */
export function approvePlan(plan: Plan): Plan {
	if (plan.status !== "needs_review") {
		throw new Error(
			`cannot approve a plan in status "${plan.status}"; request review first (status must be needs_review)`,
		);
	}
	return appendPlanRevision({ ...plan, status: "approved" }, "approval", []);
}

/**
 * Approve without a human gate (for `auto_approved` policies): goes straight
 * to `approved` from `draft` or `needs_review`. Throws from any other status.
 */
export function autoApprovePlan(plan: Plan): Plan {
	assertReviewable(plan, "auto-approve");
	return appendPlanRevision({ ...plan, status: "approved" }, "approval", []);
}

/** Action accepted by the `orchestration.plan.review` capability. */
export type ReviewGateAction = "review" | "approve";

/** Input to the review-gate capability: which plan to move and how far. */
export interface ReviewGateInput {
	planId: string;
	action: ReviewGateAction;
}

function normalizeReviewInput(input: unknown): ReviewGateInput {
	if (typeof input !== "object" || input === null) {
		throw new Error("review gate: input must be { planId, action }");
	}
	const obj = input as { planId?: unknown; action?: unknown };
	if (typeof obj.planId !== "string" || obj.planId.length === 0) {
		throw new Error("review gate: input `planId` must be a non-empty string");
	}
	if (obj.action !== "review" && obj.action !== "approve") {
		throw new Error('review gate: input `action` must be "review" or "approve"');
	}
	return { planId: obj.planId, action: obj.action };
}

/**
 * The deterministic review-gate capability (`orchestration.plan.review`):
 * loads the plan, applies the transition (honoring the gate), persists, and
 * emits `plan.approved` when the plan crosses into `approved`. Approving a
 * plan whose policy requires review moves a still-`draft` plan to
 * `needs_review` (awaiting the human) rather than force-approving it.
 */
export const reviewGateStage: PlanningStage<typeof PlanSchema> = {
	id: "orchestration.plan.review",
	category: "orchestration",
	name: "Plan Review Gate",
	description:
		"Move a plan through the §6.3.10 human approval gate (needs_review → approved), honoring policy.requireApproval.",
	inputs: ["plan", "policy"],
	outputSchema: PlanSchema,
	mandatory: true,
	run: async (input, ctx) => {
		const { planId, action } = normalizeReviewInput(input);
		const plan = await ctx.store.load(planId);
		const decision = evaluateReviewGate(plan);
		let next: Plan;
		if (action === "approve") {
			if (decision.kind === "required") {
				// A still-draft plan must pass review before it can be approved.
				next = plan.status === "needs_review" ? approvePlan(plan) : requestReview(plan);
			} else {
				next = autoApprovePlan(plan);
			}
		} else {
			next = requestReview(plan);
		}
		await ctx.store.save(next);
		if (next.status === "approved") {
			await ctx.events.emit(planApprovedEvent({ planId: plan.id }));
		}
		return next;
	},
};
