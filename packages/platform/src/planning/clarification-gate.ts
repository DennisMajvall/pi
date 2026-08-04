/**
 * Clarification Gate (§9) — deterministic, one gate not an AI stage (Step 2.4).
 *
 * Decides, with no model call, whether the current `Goal` is clear enough to
 * proceed or must pause for clarification:
 * - `clear` — no `requiresClarification` and no blocking question;
 * - `needs_clarification` — clarification is needed and `roundsUsed < maxRounds`:
 *   surface the goal's `clarificationQuestions` (falling back to its unknowns);
 * - `proceed_with_unknowns` — clarification is still needed but `roundsUsed >=
 *   maxRounds`: proceed, converting the goal's unknowns into low-confidence
 *   `Assumption`s so the plan exposes them (§13/§14) instead of stalling.
 *
 * On `needs_clarification` the caller re-runs **Goal Analysis only** (never the
 * whole pipeline) with the user's answers, incrementing `roundsUsed`, which
 * bounds the loop.
 */

import type { Assumption, ClarificationQuestion, Goal } from "../plan/index.ts";

/** Default bounded clarification round-trips (§9). */
export const DEFAULT_MAX_CLARIFICATION_ROUNDS = 2;

export interface ClarificationGateOptions {
	/** Round-trips already spent. */
	roundsUsed: number;
	/** Upper bound on clarification rounds. Defaults to 2. */
	maxRounds?: number;
}

export type ClarificationGateResult =
	| { kind: "clear" }
	| { kind: "needs_clarification"; questions: ClarificationQuestion[] }
	| { kind: "proceed_with_unknowns"; assumptions: Assumption[] };

/** Low confidence assigned to unknowns promoted to assumptions at the bound. */
const LOW_CONFIDENCE = 40;

/** Whether a goal needs clarification: it says so, or has a blocking question. */
function needsClarification(goal: Goal): boolean {
	return goal.requiresClarification || goal.clarificationQuestions.some((question) => question.blocking);
}

function blockingQuestions(goal: Goal): ClarificationQuestion[] {
	if (goal.clarificationQuestions.length > 0) {
		// Surface all explicit questions the Goal Analysis raised; the gate
		// already decided clarity, so the caller asks the user these.
		return goal.clarificationQuestions;
	}
	// No explicit questions: fall back to the unknowns (≤ reasonable count).
	return goal.unknowns.slice(0, 5).map((unknown) => ({ question: unknown, blocking: true }));
}

function unknownsToAssumptions(goal: Goal): Assumption[] {
	return goal.unknowns.map((unknown) => ({
		statement: `Assumed from unresolved unknown: ${unknown}`,
		confidence: LOW_CONFIDENCE,
		source: "inferred",
	}));
}

/**
 * Deterministically decide whether the Goal is clear, needs clarification
 * (within the bound), or must proceed with low-confidence assumptions (bound
 * exceeded).
 */
export function runClarificationGate(goal: Goal, options: ClarificationGateOptions): ClarificationGateResult {
	if (!needsClarification(goal)) {
		return { kind: "clear" };
	}
	const maxRounds = options.maxRounds ?? DEFAULT_MAX_CLARIFICATION_ROUNDS;
	if (options.roundsUsed >= maxRounds) {
		return { kind: "proceed_with_unknowns", assumptions: unknownsToAssumptions(goal) };
	}
	return { kind: "needs_clarification", questions: blockingQuestions(goal) };
}
