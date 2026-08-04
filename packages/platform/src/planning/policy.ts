/**
 * Policy guard hook (Step 2.5) — the deterministic "policy drives behavior" rule
 * (§7): constraints may downgrade a `PlanningPolicy` but never upgrade it.
 *
 * A hard resource/time constraint (Constraint Extraction, 2.6) will use this to
 * cap policy fields. All transforms are one-directional:
 * - `planningDepth` is capped to the less-deep value (low < medium < high);
 * - `parallelExecution` / `specialistAgents` / `dualPlanner` can only be set to
 *   false;
 * - `requireApproval` can only be set to true.
 *
 * A downgrade never relaxes a policy field, and never upgrades an already
 * stricter one.
 */

import type { PlanningDepth, PlanningPolicy } from "../plan/index.ts";

const DEPTH_SEVERITY: Record<PlanningDepth, number> = { low: 0, medium: 1, high: 2 };

/** A deterministic, monotonic (never-upgrade) policy reduction. */
export interface PolicyDowngrade {
	/** Cap depth downward, e.g. to "medium" (never raises it). */
	planningDepth?: PlanningDepth;
	/** Only ever disables parallelism. */
	parallelExecution?: false;
	/** Only ever disables specialist agents. */
	specialistAgents?: false;
	/** Only ever disables dual planning. */
	dualPlanner?: false;
	/** Only ever forces approval. */
	requireApproval?: true;
}

/**
 * Apply a downgrade to a policy. The result is the intersection: equal to the
 * current policy except where the downgrade is stricter.
 */
export function downgradePolicy(policy: PlanningPolicy, downgrade: PolicyDowngrade): PlanningPolicy {
	const next: PlanningPolicy = { ...policy };
	if (downgrade.planningDepth) {
		if (DEPTH_SEVERITY[policy.planningDepth] > DEPTH_SEVERITY[downgrade.planningDepth]) {
			next.planningDepth = downgrade.planningDepth;
		}
	}
	if (downgrade.parallelExecution === false) {
		next.parallelExecution = false;
	}
	if (downgrade.specialistAgents === false) {
		next.specialistAgents = false;
	}
	if (downgrade.dualPlanner === false) {
		next.dualPlanner = false;
	}
	if (downgrade.requireApproval === true) {
		next.requireApproval = true;
	}
	return next;
}
