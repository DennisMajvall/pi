/**
 * @earendil-works/pi-platform/planning
 *
 * Implementation of the generic planning-stage pattern (Step 2.3)
 * and the AI stages + deterministic folds (Steps 2.4–2.7):
 * the stage contract + strict-JSON runner + per-stage model routing, the
 * planning event surface, the stage-as-`orchestration`-capability wrapper,
 * Goal Analysis (cheap-model routed), the deterministic Clarification Gate,
 * Execution Strategy Selection, the policy guard hook, Constraint
 * Extraction's policy-downgrade fold, Task Decomposition with dedupe + budget
 * passes, the deterministic Dependency Builder + acyclicity, the Plan Critic +
 * Optimizer pair, and the deterministic Plan Validation + Planning Metrics
 * (Step 2.10). Exposed via the subpath only (implementation, like /kernel).
 */

export {
	type ClarificationGateOptions,
	type ClarificationGateResult,
	DEFAULT_MAX_CLARIFICATION_ROUNDS,
	runClarificationGate,
} from "./clarification-gate.ts";
export {
	aiComplexityVerdict,
	assessComplexityLayered,
	COMPLEXITY_MODEL_KEY,
	type ComplexityAssessment,
	type ComplexityDependencies,
	type ComplexityInput,
	type ComplexityPreFilterOptions,
	type ComplexityVerdict,
	ComplexityVerdictSchema,
	type DeterministicComplexity,
	deterministicPreFilter,
} from "./complexity.ts";
export {
	CONSTRAINT_EXTRACTION_MODEL_KEY,
	CONSTRAINT_EXTRACTION_SYSTEM_PROMPT,
	type ConstraintExtractionInput,
	ConstraintExtractionSchema,
	constraintExtractionStage,
	type RuntimeConstraintContext,
} from "./constraint-extraction.ts";
export {
	applyConstraintDowngrade,
	type ConstraintFamilies,
	foldConstraints,
	policyDowngradeFromConstraints,
} from "./constraints.ts";
export {
	CRITIC_MODEL_KEY,
	CRITIC_SYSTEM_PROMPT,
	type CriticInput,
	CriticSchema,
	type Critique,
	criticStage,
} from "./critic.ts";
export {
	buildDependencyGraph,
	type DependencyBuildOptions,
	type DependencyBuildResult,
	type DependencyCandidate,
	type DependencyEdge,
	findCircularDependencies,
} from "./dependency-builder.ts";
export {
	EVENT_PLAN_APPROVED,
	EVENT_PLAN_COMPLETED,
	EVENT_PLAN_CREATED,
	EVENT_PLAN_REPLANNING,
	type PlanLifecyclePayload,
	planApprovedEvent,
	planCompletedEvent,
	planCreatedEvent,
	planReplanningEvent,
} from "./events.ts";
export {
	attachOverlay,
	completeTask,
	ExecutionOverlay,
	type ExecutionOverlayEntry,
	type ExecutionOverlayOptions,
	ExecutionTaskStatus,
	failTask,
	markRunning,
} from "./execution-overlay.ts";
export {
	EXECUTION_STRATEGY_MODEL_KEY,
	EXECUTION_STRATEGY_SYSTEM_PROMPT,
	type ExecutionStrategyInput,
	executionStrategyStage,
} from "./execution-strategy.ts";
export {
	GOAL_ANALYSIS_MODEL_KEY,
	GOAL_ANALYSIS_SYSTEM_PROMPT,
	type GoalAnalysisInput,
	goalAnalysisStage,
} from "./goal-analysis.ts";
export {
	type AiAssessedMetrics,
	AiAssessedMetricsSchema,
	analyzeDag,
	combineMetrics,
	computeParallelism,
	type DagAnalysis,
	METRICS_MODEL_KEY,
	METRICS_SYSTEM_PROMPT,
	type MetricsInput,
	metricsStage,
} from "./metrics.ts";
export {
	appendRevision,
	changedTaskIds,
	OPTIMIZER_MODEL_KEY,
	OPTIMIZER_SYSTEM_PROMPT,
	type OptimizerInput,
	optimizerStage,
} from "./optimizer.ts";
export {
	ClarificationRequiredError,
	type PlanningPipelineContext,
	type PlanningPipelineResult,
	type PlanningStages,
	runPlanningPipeline,
} from "./orchestrator.ts";
export {
	createPlanCapabilityRunner,
	type PlanCapabilityRunner,
	type PlanCapabilityRunnerOptions,
	type PlanListEntry,
	planListEntry,
} from "./plan-capability.ts";
export {
	renderPlanDag,
	renderPlanHead,
	renderPlanView,
	renderRevisionHistory,
	renderTaskList,
} from "./plan-view.ts";
export {
	type PlanViewAction,
	type PlanViewMode,
	type PlanViewStyle,
	PlanViewWidget,
	type PlanViewWidgetOptions,
	renderTaskDetail,
} from "./plan-view-widget.ts";
export { downgradePolicy, type PolicyDowngrade } from "./policy.ts";
export {
	type CapabilityResolution,
	type CapabilityResolver,
	executeApprovedPlan,
	executeTask,
	resolveRequiredCapabilities,
	type SchedulerCapability,
	schedulerNext,
	schedulerReady,
} from "./scheduler.ts";
export {
	DEFAULT_STAGE_MODEL_ROUTING,
	definePlanningStageCapability,
	type OptionalStageResult,
	type PlanningStage,
	type PlanningStageExport,
	type PlanningStageRunContext,
	requireStageModel,
	resolveStageModel,
	runOptionalStage,
	runStrictJsonStage,
	type StageCompletion,
	type StageCompletionRequest,
	type StageModelRouting,
	type StageModelSettings,
	type StrictJsonOptions,
	type StrictJsonResult,
	stageModelRoutingFromSettings,
} from "./stage.ts";
export {
	DecomposedTaskSchema,
	TASK_DECOMPOSITION_MODEL_KEY,
	TASK_DECOMPOSITION_SYSTEM_PROMPT,
	type TaskDecompositionInput,
	TaskDecompositionSchema,
	taskDecompositionStage,
} from "./task-decomposition.ts";
export { completeTasks, type DecomposedTask, dedupeTasks, enforceMaxTasks } from "./tasks.ts";
export {
	evaluateTrigger,
	type TriggerDecision,
	type TriggerInput,
} from "./trigger.ts";
export { type CreateDraftPlanInput, createDraftPlanStage } from "./trivial.ts";
export {
	applyPlanEdit,
	applyPlanEdits,
	type PlanEdit,
	parsePlanEdit,
	type TaskRef,
	type UserEditInput,
	userEditStage,
} from "./user-edit.ts";
export {
	appendPlanRevision,
	approvePlan,
	autoApprovePlan,
	evaluateReviewGate,
	nextPlanVersion,
	type ReviewGateAction,
	type ReviewGateDecision,
	type ReviewGateInput,
	requestReview,
	reviewGateStage,
} from "./user-review.ts";
export {
	type PlanValidationResult,
	type ValidationIssue,
	ValidationIssueCode,
	validatePlan,
} from "./validation.ts";
