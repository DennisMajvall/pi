/**
 * End-to-end planning orchestrator (Step 2.12, Planning-complete).
 *
 * Chains the 2.4–2.11 stages into the §6.3 pipeline: request → Goal Analysis →
 * Clarification Gate → Execution Strategy → Constraint Extraction (+ policy
 * downgrade) → Task Decomposition → Dependency Builder → Critic → Optimizer →
 * Plan Validation → Metrics → Review gate → **approved** plan persisted on disk.
 *
 * The orchestrator is kernel-side code (like the scheduler, §6.5); each stage is
 * a `PlanningStage` (an `orchestration`-capability export, §16). It threads one
 * in-memory plan through the §6.7 stage inputs and persists once at the end,
 * emitting `plan.created` and `plan.approved`. Stages are pre-built by the host
 * with injected `StageCompletion` + `StageModelRouting` (tests pass fakes), so
 * the platform adds no settings surface here.
 */

import type { SessionId } from "../identifier/index.ts";
import { planId } from "../identifier/index.ts";
import type { PlanStore } from "../kernel/plan-store.ts";
import type { Assumption, Constraint, Goal, Plan, PlanningPolicy, Task } from "../plan/index.ts";
import type { GoalSchema, PlanningPolicySchema, PlanSchema } from "../schema/plan.ts";
import type { EventBusService } from "../service/index.ts";
import { runClarificationGate } from "./clarification-gate.ts";
import type { ConstraintExtractionSchema } from "./constraint-extraction.ts";
import { applyConstraintDowngrade, type ConstraintFamilies, foldConstraints } from "./constraints.ts";
import type { CriticSchema, Critique } from "./critic.ts";
import { buildDependencyGraph, type DependencyEdge } from "./dependency-builder.ts";
import { planApprovedEvent, planCreatedEvent } from "./events.ts";
import {
	type AiAssessedMetrics,
	type AiAssessedMetricsSchema,
	analyzeDag,
	combineMetrics,
	computeParallelism,
} from "./metrics.ts";
import type { OptionalStageResult, PlanningStage } from "./stage.ts";
import type { TaskDecompositionSchema } from "./task-decomposition.ts";
import { completeTasks } from "./tasks.ts";
import { approvePlan, autoApprovePlan, evaluateReviewGate, requestReview } from "./user-review.ts";
import { ValidationIssueCode, validatePlan } from "./validation.ts";

/** The stage set the pipeline drives (all injected/bound by the host; fakes in tests). */
export interface PlanningStages {
	goal: PlanningStage<typeof GoalSchema>;
	strategy: PlanningStage<typeof PlanningPolicySchema>;
	constraints: PlanningStage<typeof ConstraintExtractionSchema>;
	tasks: PlanningStage<typeof TaskDecompositionSchema>;
	critic: PlanningStage<typeof CriticSchema>;
	optimizer: PlanningStage<typeof PlanSchema>;
	metrics: PlanningStage<typeof AiAssessedMetricsSchema>;
}

/** What the running pipeline has access to: store, events, and optional context. */
export interface PlanningPipelineContext {
	store: PlanStore;
	events: EventBusService;
	sessionId?: SessionId;
	/** Answers to the clarification gate's questions (walking skeleton: caller collects then proceeds). */
	clarifyAnswers?: Record<string, string>;
	/** Capability ids worth offering to Task Decomposition (optional). */
	availableCapabilities?: string[];
}

/** Outcome of a completed pipeline run. */
export interface PlanningPipelineResult {
	plan: Plan;
	/** How the plan got to `approved` (via the required gate or a waived policy). */
	outcome: "required" | "auto_approved";
}

/**
 * Thrown when the Clarification Gate (§9) finds blocking questions and the
 * caller has not supplied answers. Carries the questions so the caller can
 * collect them and re-run Goal Analysis only (bounded by the gate).
 */
export class ClarificationRequiredError extends Error {
	readonly questions: readonly { question: string; blocking: boolean }[];
	constructor(questions: readonly { question: string; blocking: boolean }[]) {
		super(`planning paused: clarification required (${questions.length} blocking question(s))`);
		this.name = "ClarificationRequiredError";
		this.questions = questions;
	}
}

/**
 * Run the full §6.3 pipeline for a request and persist the approved plan.
 *
 * Throws `ClarificationRequiredError` when the goal needs clarification and no
 * answers were provided; throws when a stage output violates the plan contract
 * (a pipeline bug, per §6.3.8).
 */
export async function runPlanningPipeline(
	request: string,
	stages: PlanningStages,
	ctx: PlanningPipelineContext,
): Promise<PlanningPipelineResult> {
	const stageCtx = { store: ctx.store, events: ctx.events, sessionId: ctx.sessionId };

	// 1. Goal Analysis (cheap model).
	const goal = (await stages.goal.run({ userRequest: request }, stageCtx)) as Goal;

	// 2. Clarification Gate (deterministic).
	const gate = runClarificationGate(goal, { roundsUsed: 0 });
	if (gate.kind === "needs_clarification" && !ctx.clarifyAnswers) {
		throw new ClarificationRequiredError(gate.questions);
	}
	const assumptions = assumptionsFromGate(gate, ctx);

	// 3. Execution Strategy → policy; Constraint Extraction → constraints (+ downgrade).
	const policy = (await stages.strategy.run({ goal }, stageCtx)) as PlanningPolicy;
	const families = (await stages.constraints.run({ goal }, stageCtx)) as ConstraintFamilies;
	const constraints = foldConstraints(families);
	const effectivePolicy = applyConstraintDowngrade(policy, constraints);

	// 4. Task Decomposition + deterministic Dependency Builder → DAG tasks.
	const decomposition = (await stages.tasks.run(
		{ goal, constraints, policy: effectivePolicy, availableCapabilities: ctx.availableCapabilities },
		stageCtx,
	)) as { tasks: Array<{ id: string; title: string; purpose: string; deliverable: string }> };
	const completed = completeTasks(decomposition.tasks);
	const dag = await buildDependencyGraph(completed);
	const tasks = dag.tasks;

	// 5. Critic (optional) then Optimizer (optional) on the assembled draft.
	const draft = buildDraftPlan(goal, effectivePolicy, constraints, assumptions, tasks);
	const edges: DependencyEdge[] = collectEdges(tasks);
	const criticResult = (await stages.critic.run(
		{ goal, constraints, tasks, edges, policy: effectivePolicy },
		stageCtx,
	)) as OptionalStageResult<Critique>;
	const critique = criticResult.kind === "ok" ? criticResult.output : undefined;
	const optimizerResult = (await stages.optimizer.run(
		{ plan: draft, critique, policy: effectivePolicy },
		stageCtx,
	)) as OptionalStageResult<Plan>;
	let plan: Plan = optimizerResult.kind === "ok" ? optimizerResult.output : draft;

	// 6. Deterministic Plan Validation. Structural issues (schema violation, cycle)
	// are a hard failure — a plan must never persist invalid or cyclic. Coverage
	// issues (unreachable success criterion, missing task purpose, duplicate
	// deliverable) are non-fatal for real-model output: the plan persists with the
	// issues surfaced as low-confidence notes so the user can review, edit, and
	// iterate on it (via /plans + prompt-driven edits) instead of discarding the
	// whole plan because a model phrased criteria differently than task artifacts.
	const validation = validatePlan(plan);
	const structuralIssues = validation.issues.filter(
		(issue) => issue.code === ValidationIssueCode.Schema || issue.code === ValidationIssueCode.Cycle,
	);
	if (structuralIssues.length > 0) {
		throw new Error(
			`planning pipeline: plan failed structural validation (${structuralIssues
				.map((issue) => `${issue.code}: ${issue.message}`)
				.join("; ")})`,
		);
	}
	const coverageNotes = validation.issues.filter(
		(issue) =>
			issue.code === ValidationIssueCode.UnreachableCriterion ||
			issue.code === ValidationIssueCode.TaskPurpose ||
			issue.code === ValidationIssueCode.DuplicateDeliverable,
	);
	if (coverageNotes.length > 0) {
		plan = {
			...plan,
			assumptions: [
				...plan.assumptions,
				...coverageNotes.map((issue) => ({
					statement: `Validation note: ${issue.message}`,
					confidence: 40,
					source: "inferred" as const,
				})),
			],
		};
	}

	// 7. Metrics (optional, non-mutating) → §14 Metrics on the plan.
	const metricsResult = (await stages.metrics.run(
		{ plan, analysis: analyzeDag(plan.tasks) },
		stageCtx,
	)) as OptionalStageResult<AiAssessedMetrics>;
	if (metricsResult.kind === "ok") {
		plan = { ...plan, metrics: combineMetrics(metricsResult.output, computeParallelism(plan.tasks)) };
	}

	// 8. Review gate → approved, then persist once and announce.
	const decision = evaluateReviewGate(plan);
	const approved = decision.kind === "required" ? approvePlan(requestReview(plan)) : autoApprovePlan(plan);

	await ctx.store.save(approved);
	await ctx.events.emit(planCreatedEvent({ planId: approved.id, sessionId: ctx.sessionId }));
	await ctx.events.emit(planApprovedEvent({ planId: approved.id, sessionId: ctx.sessionId }));

	return { plan: approved, outcome: decision.kind === "required" ? "required" : "auto_approved" };
}

/** Derive low-confidence / user-provided assumptions from the gate or answers. */
function assumptionsFromGate(
	gate: ReturnType<typeof runClarificationGate>,
	ctx: PlanningPipelineContext,
): Assumption[] {
	const assumptions: Assumption[] = [];
	if (gate.kind === "proceed_with_unknowns") {
		assumptions.push(...gate.assumptions);
	}
	if (ctx.clarifyAnswers) {
		for (const [question, answer] of Object.entries(ctx.clarifyAnswers)) {
			assumptions.push({ statement: `${question}: ${answer}`, confidence: 80, source: "user" });
		}
	}
	return assumptions;
}

/** Extract dependency edges from the DAG's `dependsOn` for the Critic. */
function collectEdges(tasks: Task[]): DependencyEdge[] {
	const edges: DependencyEdge[] = [];
	for (const task of tasks) {
		for (const dep of task.dependsOn) {
			edges.push({ from: String(dep), to: String(task.id) });
		}
	}
	return edges;
}

function buildDraftPlan(
	goal: Goal,
	policy: PlanningPolicy,
	constraints: Constraint[],
	assumptions: Assumption[],
	tasks: Task[],
): Plan {
	const now = Date.now();
	return {
		id: planId(),
		schemaVersion: 1,
		goal,
		policy,
		constraints,
		assumptions,
		tasks,
		revisions: [],
		status: "draft",
		createdAt: now,
		updatedAt: now,
	};
}
