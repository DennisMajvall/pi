/**
 * Constraint folding + the deterministic policy-downgrade rule (§6.3.3/§7).
 *
 * The four AI-extracted constraint families fold into `Plan.constraints`
 * (`{ kind: hard|soft|resource|policy, description }`), and hard resource/time
 * constraints deterministically *downgrade* the stored `PlanningPolicy` — never
 * upgrade it (§7). Feeds the Step 2.5 `downgradePolicy` guard hook.
 */

import type { Constraint, PlanningPolicy } from "../plan/index.ts";
import { downgradePolicy, type PolicyDowngrade } from "./policy.ts";

/** The four constraint families produced by the Constraint Extraction stage. */
export interface ConstraintFamilies {
	hardConstraints: string[];
	softConstraints: string[];
	resourceConstraints: string[];
	policyConstraints: string[];
}

const FAMILY_KIND: Record<keyof ConstraintFamilies, Constraint["kind"]> = {
	hardConstraints: "hard",
	softConstraints: "soft",
	resourceConstraints: "resource",
	policyConstraints: "policy",
};

/** Fold the four families into the stored `Plan.constraints` form. */
export function foldConstraints(families: ConstraintFamilies): Constraint[] {
	const constraints: Constraint[] = [];
	for (const [familyName, descriptions] of Object.entries(families)) {
		const kind = FAMILY_KIND[familyName as keyof ConstraintFamilies];
		for (const description of descriptions) {
			constraints.push({ kind, description });
		}
	}
	return constraints;
}

// Deterministic keyword signals. Only hard / resource constraints downgrade.
const TIME_SIGNAL = /\b(time|deadline|hour|hours|day|days|week|weeks|month)\b/i;
const PARALLEL_SIGNAL =
	/\b(parallel|concurrent|serial|sequential|one at a time|at a time|single.?thread|no ?parallel)\b/i;
const APPROVAL_SIGNAL =
	/\b(approval|sign ?off)\b|\breview(?:ed)? (?:before|required)\b|\bmust (?:be )?review(?:ed)?\b/i;
const BUDGET_SIGNAL = /\b(budget|resource|compute|cost|limited|no extra spend)\b/i;

/**
 * Deterministically derive a `PolicyDowngrade` from hard/resource constraints:
 * time limit → cap depth to medium; parallelism limit → disable parallelism;
 * approval (hard) → force approval; budget/resource → drop specialists + dual
 * planner. Soft/policy constraints never downgrade.
 */
export function policyDowngradeFromConstraints(constraints: Constraint[]): PolicyDowngrade {
	let downgrade: PolicyDowngrade = {};
	for (const constraint of constraints) {
		const binding = constraint.kind === "hard" || constraint.kind === "resource";
		if (!binding) {
			continue;
		}
		if (TIME_SIGNAL.test(constraint.description)) {
			downgrade = { ...downgrade, planningDepth: "medium" };
		}
		if (PARALLEL_SIGNAL.test(constraint.description)) {
			downgrade = { ...downgrade, parallelExecution: false };
		}
		if (constraint.kind === "hard" && APPROVAL_SIGNAL.test(constraint.description)) {
			downgrade = { ...downgrade, requireApproval: true };
		}
		if (BUDGET_SIGNAL.test(constraint.description)) {
			downgrade = { ...downgrade, specialistAgents: false, dualPlanner: false };
		}
	}
	return downgrade;
}

/** Apply the constraint-derived downgrade to a policy (never upgrades, §7). */
export function applyConstraintDowngrade(policy: PlanningPolicy, constraints: Constraint[]): PlanningPolicy {
	return downgradePolicy(policy, policyDowngradeFromConstraints(constraints));
}
