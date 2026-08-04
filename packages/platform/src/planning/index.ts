/**
 * @earendil-works/pi-platform/planning
 *
 * Implementation of the generic planning-stage pattern (Step 2.3):
 * the stage contract + strict-JSON runner + per-stage model routing, the
 * planning event surface, and the stage-as-`orchestration`-capability wrapper,
 * with one trivial non-AI stage as the walking skeleton every later stage
 * follows. Exposed via the subpath only (implementation, like /kernel).
 */

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
	DEFAULT_STAGE_MODEL_ROUTING,
	definePlanningStageCapability,
	type PlanningStage,
	type PlanningStageExport,
	type PlanningStageRunContext,
	resolveStageModel,
	runStrictJsonStage,
	type StageCompletion,
	type StageCompletionRequest,
	type StageModelRouting,
	type StrictJsonOptions,
	type StrictJsonResult,
} from "./stage.ts";
export { type CreateDraftPlanInput, createDraftPlanStage } from "./trivial.ts";
