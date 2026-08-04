/**
 * Planning Metrics (Architecture §6.3.9 + §14) — Step 2.10.
 *
 * The `Metrics` object on the plan splits into:
 * - **Deterministic (DAG-derived):** `parallelism` (width / critical path),
 *   plus the diagnostic `analyzeDag` summary (task count vs `maxTasks`,
 *   dependency density). No LLM involved.
 * - **AI-assessed (small, non-mutating prompt):** completeness, confidence,
 *   risk, unknown count, missing information. Produced by the optional
 *   `metricsStage` (§11 — skipped, never aborts) and combined with the
 *   deterministic parallelism via `combineMetrics`.
 */
import { type Static, Type } from "typebox";
import type { Metrics, Plan, PlanRisk, Task } from "../plan/index.ts";
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

/** Stage/model-routing key for the AI Metrics assessment. */
export const METRICS_MODEL_KEY = "metrics";

/**
 * Strict output of the AI metrics stage: only the subjectively-assessed fields.
 * `parallelism` is deliberately absent — it is computed deterministically from
 * the DAG (§14), never hallucinated by a model.
 */
export const AiAssessedMetricsSchema = Type.Object(
	{
		completeness: Type.Number({ minimum: 0, maximum: 100 }),
		confidence: Type.Number({ minimum: 0, maximum: 100 }),
		risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
		unknownCount: Type.Integer({ minimum: 0 }),
		missingInformation: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

/** The AI-assessed (subjective) part of `Metrics` (§14). */
export interface AiAssessedMetrics {
	completeness: number;
	confidence: number;
	risk: PlanRisk;
	unknownCount: number;
	missingInformation: string[];
}

/** §6.3.9 exemplar system prompt: score the plan objectively, never modify it. */
export const METRICS_SYSTEM_PROMPT =
	"You are Pi's objective Plan Metrics assessor. Score the plan objectively. " +
	"Do not modify it. Assess completeness, confidence, risk, and unknowns from " +
	"the plan and its DAG statistics. Return valid JSON matching the AiAssessedMetrics " +
	"schema. `parallelism` is computed from the DAG by the system, so do not include it.";

/** Structured, non-mutating input: the whole plan plus deterministic DAG stats. */
export interface MetricsInput {
	plan: Plan;
	analysis: DagAnalysis;
}

/** Additive DAG summary produced deterministically (Architecture §6.3.9). */
export interface DagAnalysis {
	taskCount: number;
	edgeCount: number;
	/** Longest chain length in edges (tasks on the critical path = maxRank + 1). */
	maxRank: number;
	/** Maximum number of tasks at the same topological rank (width proxy). */
	maxRankWidth: number;
	/** Average incoming dependencies per task. */
	dependencyDensity: number;
}

/**
 * Analyze the task DAG deterministically. Ranks are the longest path from a
 * source task (rank = 0 for a no-dependency task), computed by memoized DFS
 * over `dependsOn`. `maxRank` is the critical path in edges; `maxRankWidth`
 * is the most tasks sharing a single rank (a width proxy).
 */
export function analyzeDag(tasks: Task[]): DagAnalysis {
	const rank = new Map<string, number>();
	for (const task of tasks) {
		rank.set(String(task.id), 0);
	}
	let edgeCount = 0;
	for (const task of tasks) {
		edgeCount += task.dependsOn.length;
	}

	// rank(task) = 0 if no deps else 1 + max(rank(dep)). Memoized DFS.
	const visiting = new Set<string>();
	const rankOf = (id: string, deps: string[]): number => {
		const cached = rank.get(id);
		if (cached !== undefined && cached > 0) {
			return cached;
		}
		if (deps.length === 0) {
			return 0;
		}
		if (visiting.has(id)) {
			return 0; // cycle guard; metrics run on the validated DAG
		}
		visiting.add(id);
		let best = 0;
		for (const dep of deps) {
			const depTask = tasks.find((t) => String(t.id) === dep);
			best = Math.max(best, 1 + rankOf(dep, depTask ? depTask.dependsOn.map(String) : []));
		}
		visiting.delete(id);
		rank.set(id, best);
		return best;
	};

	let maxRank = 0;
	const widthByRank = new Map<number, number>();
	for (const task of tasks) {
		const r = rankOf(String(task.id), task.dependsOn.map(String));
		maxRank = Math.max(maxRank, r);
		widthByRank.set(r, (widthByRank.get(r) ?? 0) + 1);
	}
	let maxRankWidth = tasks.length > 0 ? 1 : 0;
	for (const width of widthByRank.values()) {
		maxRankWidth = Math.max(maxRankWidth, width);
	}

	return {
		taskCount: tasks.length,
		edgeCount,
		maxRank,
		maxRankWidth,
		dependencyDensity: tasks.length > 0 ? edgeCount / tasks.length : 0,
	};
}

/**
 * Compute the DAG-derived `parallelism` metric (§14): width / critical path,
 * as a 0–100 score. Width is approximated by `maxRankWidth` (the most tasks at
 * one topological rank); the critical path is `maxRank + 1` tasks. A wide,
 * shallow DAG scores high; a long, narrow chain scores low.
 */
export function computeParallelism(tasks: Task[]): number {
	const analysis = analyzeDag(tasks);
	if (analysis.taskCount === 0) {
		return 0;
	}
	const criticalPath = analysis.maxRank + 1;
	return Math.max(0, Math.min(100, Math.round((analysis.maxRankWidth / criticalPath) * 100)));
}

/**
 * Combine the AI-assessed (subjective) fields with the deterministic
 * `parallelism` into the full §14 `Metrics` object. `parallelism` is always the
 * DAG-derived value passed in — never a model value.
 */
export function combineMetrics(ai: AiAssessedMetrics, parallelism: number): Metrics {
	return {
		completeness: ai.completeness,
		confidence: ai.confidence,
		parallelism,
		risk: ai.risk,
		unknownCount: ai.unknownCount,
		missingInformation: ai.missingInformation,
	};
}

function buildMetricsPrompt(input: MetricsInput): string {
	return [
		"<plan>",
		JSON.stringify(input.plan),
		"</plan>",
		"<dag>",
		`tasks: ${input.analysis.taskCount}`,
		`dependencies: ${input.analysis.edgeCount}`,
		`critical_path_tasks: ${input.analysis.maxRank + 1}`,
		`max_width: ${input.analysis.maxRankWidth}`,
		`dependency_density: ${input.analysis.dependencyDensity.toFixed(2)}`,
		"</dag>",
	].join("\n");
}

/**
 * Build the AI Metrics `PlanningStage` (§6.3.9), injecting the model
 * `completion` (host binds a real model at 2.12 wiring; tests pass a fake).
 * Non-mutating: it scores the plan and returns the subjective fields; it never
 * persists or edits the plan. **Optional** (§11) — on repeated failure it
 * returns `{ kind: "skipped" }`, never aborting.
 */
export function metricsStage(
	completion: StageCompletion,
	routing: StageModelRouting = DEFAULT_STAGE_MODEL_ROUTING,
): PlanningStage<typeof AiAssessedMetricsSchema> {
	return {
		id: "orchestration.metrics",
		category: "orchestration",
		name: "Planning Metrics",
		description: "Objectively score plan completeness/confidence/risk/unknowns without modifying it.",
		systemPrompt: METRICS_SYSTEM_PROMPT,
		inputs: ["plan"],
		outputSchema: AiAssessedMetricsSchema,
		mandatory: false,
		modelKey: METRICS_MODEL_KEY,
		run: async (input) => {
			const model = requireStageModel(METRICS_MODEL_KEY, resolveStageModel(METRICS_MODEL_KEY, routing));
			return (await runOptionalStage<typeof AiAssessedMetricsSchema>({
				completion,
				systemPrompt: METRICS_SYSTEM_PROMPT,
				userPrompt: buildMetricsPrompt(input as MetricsInput),
				outputSchema: AiAssessedMetricsSchema,
				model,
				mandatory: false,
				stageName: "metrics",
			})) as OptionalStageResult<Static<typeof AiAssessedMetricsSchema>>;
		},
	};
}
