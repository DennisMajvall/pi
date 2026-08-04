/**
 * Plan capability runner + view model (Step 2.13.1).
 *
 * The seam between the persistent plan core (2.2/2.11) and any review surface —
 * the TUI plan view (2.13) or an external adapter. It abstracts the
 * `orchestration.plan.*` operations the review surface drives:
 *
 *   list()   → the on-disk plans as display entries (read-through, § read from
 *              the store so external edits never drift);
 *   load()   → the full Plan (read-through);
 *   review() → the §6.3.10 gate (`needs_review → approved`, honoring
 *              `policy.requireApproval`), emitting `plan.approved`;
 *   edit()   → a schema-preserving conversational `user_edit`.
 *
 * The default implementation is built directly over the 2.11 capabilities
 * (`reviewGateStage` / `userEditStage`) and the `PlanStore`, so a review surface
 * and the live host share one behavior. Pure and deterministic — no terminal,
 * no model — so it is fully testable headlessly.
 */

import type { SessionId } from "../identifier/index.ts";
import type { PlanStore } from "../kernel/plan-store.ts";
import type { Plan, PlanStatus } from "../plan/index.ts";
import type { EventBusService } from "../service/index.ts";
import type { PlanEdit } from "./user-edit.ts";
import { userEditStage } from "./user-edit.ts";
import { reviewGateStage } from "./user-review.ts";

/** One plan as shown in a plan-list surface (title/status/revision/task count). */
export interface PlanListEntry {
	id: string;
	/** The goal summary — the human-readable title. */
	title: string;
	status: PlanStatus;
	/** Latest revision version (1 if none yet). */
	version: number;
	taskCount: number;
	/** Compact §14 metrics summary, when the plan is scored. */
	metrics?: string;
}

/** Build a display entry from a plan (pure; deterministic). */
export function planListEntry(plan: Plan): PlanListEntry {
	const version = plan.revisions.length > 0 ? plan.revisions[plan.revisions.length - 1]!.version : 1;
	const metrics = plan.metrics
		? `completeness ${plan.metrics.completeness} · confidence ${plan.metrics.confidence} · risk ${plan.metrics.risk}`
		: undefined;
	return {
		id: String(plan.id),
		title: plan.goal.summary,
		status: plan.status,
		version,
		taskCount: plan.tasks.length,
		metrics,
	};
}

/** Options for building the default `PlanCapabilityRunner`. */
export interface PlanCapabilityRunnerOptions {
	store: PlanStore;
	events: EventBusService;
	sessionId?: SessionId;
}

/**
 * The operations a plan review surface can perform. `list`/`load` are read-through;
 * `review`/`edit` mutate and persist (full-document re-store per revision, §8).
 */
export interface PlanCapabilityRunner {
	/** List the on-disk plans as display entries (in store order). */
	list(): Promise<PlanListEntry[]>;
	/** Load a full plan fresh from disk (throws if absent/invalid). */
	load(planId: string): Promise<Plan>;
	/** Drive the review gate: `review` → `needs_review`; `approve` → `approved` (per policy). */
	review(planId: string, action: "review" | "approve"): Promise<Plan>;
	/** Apply a schema-preserving conversational edit (directive string or typed `PlanEdit`). */
	edit(planId: string, edit: PlanEdit | string): Promise<Plan>;
}

/**
 * The default runner over the 2.11 capabilities. `review` reuses
 * `reviewGateStage` (loads → honors `policy.requireApproval` → persists → emits
 * `plan.approved`); `edit` reuses `userEditStage` (parses a directive if given →
 * schema-preserving apply → persists).
 */
export function createPlanCapabilityRunner(options: PlanCapabilityRunnerOptions): PlanCapabilityRunner {
	const ctx = { store: options.store, events: options.events, sessionId: options.sessionId };
	return {
		async list() {
			const entries: PlanListEntry[] = [];
			for (const summary of await options.store.list()) {
				const plan = await options.store.load(summary.id).catch(() => null);
				// Skip an unreadable/invalid on-disk file (it fails loudly on load alone).
				if (plan) {
					entries.push(planListEntry(plan));
				}
			}
			return entries;
		},
		async load(planId: string) {
			return options.store.load(planId);
		},
		async review(planId: string, action: "review" | "approve") {
			return (await reviewGateStage.run({ planId, action }, ctx)) as Plan;
		},
		async edit(planId: string, edit: PlanEdit | string) {
			return (await userEditStage.run({ planId, edit }, ctx)) as Plan;
		},
	};
}
