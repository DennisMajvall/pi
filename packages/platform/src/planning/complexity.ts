/**
 * Layered complexity detection (Step 2.12 entry trigger, §6.3.1-adjacent).
 *
 * Two gates, cheapest first, decide whether a prompt warrants planning *before*
 * execution:
 *
 * 1. **Deterministic pre-filter** — a cheap, pure score from prompt length,
 *    tool-call volume, token/scope estimate, and multi-step key signals. Below a
 *    floor threshold it short-circuits to "not complex" with no model call.
 * 2. **AI judgment** — Goal-Analysis-family verdict on a purpose-chosen **cheap**
 *    model (the same cheap model backs Goal Analysis, 2.4), returning a strict
 *    `ComplexityVerdict`. This keeps the cheap judgment off the expensive models
 *    used by later stages.
 *
 * The pre-filter is the deterministic first gate; the AI layer only runs when the
 * pre-filter crosses the floor, so trivial prompts never pay a model round-trip.
 */

import type { Static } from "typebox";
import { Type } from "typebox";
import {
	DEFAULT_STAGE_MODEL_ROUTING,
	requireStageModel,
	resolveStageModel,
	runStrictJsonStage,
	type StageCompletion,
	type StageModelRouting,
} from "./stage.ts";

/** Stage/model-routing key for the complexity judgment (cheap model). */
export const COMPLEXITY_MODEL_KEY = "complexity";

/** The objective signals complexity detection considers. */
export interface ComplexityInput {
	userRequest: string;
	/** Prompt length in characters (defaults to `userRequest.length`). */
	promptLength?: number;
	/** Number of tool calls the prompt implies (volume of work). */
	toolCallCount?: number;
	/** Token/scope estimate for the request. */
	estimatedTokens?: number;
	/** Multi-step / scope hints detected by the caller (e.g. "then", "multiple files"). */
	scopeHeuristics?: string[];
}

/** Tunable thresholds for the deterministic pre-filter. */
export interface ComplexityPreFilterOptions {
	/** Below this score → "not complex" immediately (no model call). Default 30. */
	floorThreshold?: number;
}

/** The deterministic pre-filter outcome. */
export interface DeterministicComplexity {
	/** 0–100 composite score (cheap, pure). */
	score: number;
	/** True iff the score crosses the floor and warrants an AI judgment. */
	escalate: boolean;
	/** Why the score came out the way it did (for the trigger/report). */
	reasons: string[];
}

/** Strict verdict schema for the cheap-model complexity judgment. */
export const ComplexityVerdictSchema = Type.Object(
	{
		planWarranted: Type.Boolean(),
		reason: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

/** The strict AI verdict (`planWarranted` decided on the cheap model). */
export type ComplexityVerdict = Static<typeof ComplexityVerdictSchema>;

/** The composite layered result. */
export interface ComplexityAssessment {
	planWarranted: boolean;
	/** Which layer made the call: the deterministic pre-filter or the AI judgment. */
	stage: "pre_filter" | "ai";
	reason: string;
	/** The pre-filter score that fed the decision. */
	score: number;
}

/** Multi-step key signals the deterministic pre-filter scans for. */
const SCOPE_SIGNALS = /\b(then|next|afterwards|multiple|several|deployment|migration|end.?to.?end|integrat)\b/i;

/**
 * The deterministic pre-filter (gate 1). Pure, no model call. Score is a blended
 * 0–100 from prompt length, tool-call volume, token/scope estimate, plus scope
 * heuristics. Below the floor it short-circuits (no AI escalation).
 */
export function deterministicPreFilter(
	input: ComplexityInput,
	options: ComplexityPreFilterOptions = {},
): DeterministicComplexity {
	const reasons: string[] = [];
	const promptLength = input.promptLength ?? input.userRequest.length;
	const toolCalls = input.toolCallCount ?? 0;
	const tokens = input.estimatedTokens ?? 0;

	const lengthScore = Math.min(100, Math.round((promptLength / 1200) * 100));
	const toolScore = Math.min(100, toolCalls * 25);
	const tokenScore = Math.min(100, Math.round((tokens / 4000) * 100));
	let hintScore = 0;
	for (const hint of input.scopeHeuristics ?? []) {
		if (SCOPE_SIGNALS.test(hint) || SCOPE_SIGNALS.test(input.userRequest)) {
			hintScore = Math.max(hintScore, 35);
		}
	}

	const score = Math.min(100, Math.round((lengthScore + toolScore + tokenScore + hintScore) / 4));
	if (promptLength >= 400) {
		reasons.push(`long prompt (${promptLength} chars)`);
	}
	if (toolCalls >= 2) {
		reasons.push(`${toolCalls}+ tool calls implied`);
	}
	if (tokens >= 2000) {
		reasons.push(`estimated ${tokens} tokens`);
	}
	if (hintScore > 0) {
		reasons.push("multi-step scope signals detected");
	}

	const floorThreshold = options.floorThreshold ?? 30;
	return { score, escalate: score >= floorThreshold, reasons };
}

/**
 * Cheap-model complexity judgment (gate 2): a mandatory strict-JSON stage that
 * returns `{ planWarranted, reason? }`. Routed (like Goal Analysis) to the cheap
 * `complexity` model via `resolveStageModel`.
 */
export async function aiComplexityVerdict(
	input: ComplexityInput,
	completion: StageCompletion,
	routing: StageModelRouting = DEFAULT_STAGE_MODEL_ROUTING,
): Promise<ComplexityVerdict> {
	const model = requireStageModel(COMPLEXITY_MODEL_KEY, resolveStageModel(COMPLEXITY_MODEL_KEY, routing));
	const result = await runStrictJsonStage<typeof ComplexityVerdictSchema>({
		completion,
		systemPrompt:
			"You are Pi's complexity judgment module. Decide whether this request warrants " +
			"producing a full plan before execution, or is simple enough to handle directly. " +
			"Return valid JSON matching the ComplexityVerdict schema.",
		userPrompt: [
			"<user_request>",
			input.userRequest,
			"</user_request>",
			`<estimated_tokens>${input.estimatedTokens ?? 0}</estimated_tokens>`,
			`<tool_calls>${input.toolCallCount ?? 0}</tool_calls>`,
		].join("\n"),
		outputSchema: ComplexityVerdictSchema,
		model,
		mandatory: true,
		stageName: "complexity",
	});
	if (result.kind === "ok") {
		return result.output as ComplexityVerdict;
	}
	// §11 mandatory stage: abort with the diagnostic.
	throw new Error(result.error);
}

/** Wiring for the layered assessment (pre-filter + AI judgment). */
export interface ComplexityDependencies {
	completion: StageCompletion;
	routing?: StageModelRouting;
	preFilter?: ComplexityPreFilterOptions;
}

/**
 * Compose the two gates. The pre-filter short-circuits below the floor (no model
 * call); otherwise the cheap-model AI judgment makes the final call.
 */
export async function assessComplexityLayered(
	input: ComplexityInput,
	deps: ComplexityDependencies,
): Promise<ComplexityAssessment> {
	const pre = deterministicPreFilter(input, deps.preFilter);
	if (!pre.escalate) {
		return {
			planWarranted: false,
			stage: "pre_filter",
			reason: pre.reasons.length > 0 ? pre.reasons.join("; ") : `low complexity (score ${pre.score})`,
			score: pre.score,
		};
	}
	const verdict = await aiComplexityVerdict(input, deps.completion, deps.routing);
	return {
		planWarranted: verdict.planWarranted,
		stage: "ai",
		reason: verdict.reason ?? `AI judgment (score ${pre.score})`,
		score: pre.score,
	};
}
