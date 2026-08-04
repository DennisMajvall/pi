/**
 * Hybrid entry trigger (Step 2.12, confirmed decision).
 *
 * How a request reaches the planning pipeline:
 *
 *   (b) explicit — `/plan <request>` always runs the pipeline;
 *   (c) automatic — otherwise, when the layered complexity check (deterministic
 *       pre-filter + cheap-model AI judgment) deems a prompt complex enough to
 *       warrant a plan, planning engages without being asked.
 *
 * Simple prompts never route through planning. Policy is deterministic (`/plan`
 * always wins, auto only on layered warrant); the only AI in the path is the
 * cheap complexity judgment.
 */

import type { ComplexityAssessment, ComplexityInput } from "./complexity.ts";
import { assessComplexityLayered, type ComplexityDependencies } from "./complexity.ts";

/** Input to the entry trigger. */
export interface TriggerInput {
	/** The user's request (also used by the AI complexity layer). */
	request: string;
	/** True when the user invoked `/plan <request>` explicitly. */
	explicit: boolean;
	/** Extra complexity signals (tool-call volume, token estimate, scope hints). */
	complexity?: Omit<ComplexityInput, "userRequest">;
}

/** The trigger's decision. */
export type TriggerDecision =
	| { engage: true; mode: "explicit" | "auto"; reason: string }
	| { engage: false; reason: string };

/**
 * Decide whether to engage planning for a request. Explicit `/plan` always
 * engages (`mode: "explicit"`); otherwise the layered complexity assessment runs
 * and planning engages iff it is warranted (`mode: "auto"`).
 */
export async function evaluateTrigger(input: TriggerInput, deps: ComplexityDependencies): Promise<TriggerDecision> {
	if (input.explicit) {
		return { engage: true, mode: "explicit", reason: "explicit /plan command" };
	}
	const assessment: ComplexityAssessment = await assessComplexityLayered(
		{ userRequest: input.request, ...input.complexity },
		deps,
	);
	if (assessment.planWarranted) {
		return { engage: true, mode: "auto", reason: assessment.reason };
	}
	return { engage: false, reason: assessment.reason };
}
