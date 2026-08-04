/**
 * @earendil-works/pi-platform/planning
 *
 * Implementation of the generic planning-stage pattern (Step 2.3)
 * and the first real AI stage + deterministic gate (Step 2.4):
 * the stage contract + strict-JSON runner + per-stage model routing, the
 * planning event surface, the stage-as-`orchestration`-capability wrapper,
 * Goal Analysis (cheap-model routed) and the deterministic Clarification Gate.
 * Exposed via the subpath only (implementation, like /kernel).
 */

export {
	type ClarificationGateOptions,
	type ClarificationGateResult,
	DEFAULT_MAX_CLARIFICATION_ROUNDS,
	runClarificationGate,
} from "./clarification-gate.ts";
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
	GOAL_ANALYSIS_MODEL_KEY,
	GOAL_ANALYSIS_SYSTEM_PROMPT,
	type GoalAnalysisInput,
	goalAnalysisStage,
} from "./goal-analysis.ts";
export {
	DEFAULT_STAGE_MODEL_ROUTING,
	definePlanningStageCapability,
	type PlanningStage,
	type PlanningStageExport,
	type PlanningStageRunContext,
	requireStageModel,
	resolveStageModel,
	runStrictJsonStage,
	type StageCompletion,
	type StageCompletionRequest,
	type StageModelRouting,
	type StageModelSettings,
	type StrictJsonOptions,
	type StrictJsonResult,
	stageModelRoutingFromSettings,
} from "./stage.ts";
export { type CreateDraftPlanInput, createDraftPlanStage } from "./trivial.ts";
