/**
 * Planning event surface (Step 2.3).
 *
 * The four planning lifecycle events flow over the existing EventBusService
 * (Architecture §16). Type consts and factory helpers only — the canonical
 * `PlatformEvent` envelope from /event is reused. These consts are deliberately
 * NOT added to the contract `PlatformEventType`: the platform contract layer is
 * frozen, and the planning events are a kanban of this feature, not a contract
 * change.
 */

import type { EventSource, PlatformEvent } from "../event/index.ts";
import { createEvent, EventScope, eventType } from "../event/index.ts";
import type { PlanId, SessionId } from "../identifier/index.ts";

export const EVENT_PLAN_CREATED = eventType("plan.created");
export const EVENT_PLAN_APPROVED = eventType("plan.approved");
export const EVENT_PLAN_REPLANNING = eventType("plan.replanning");
export const EVENT_PLAN_COMPLETED = eventType("plan.completed");

/** Which plan a planning lifecycle event concerns. */
export interface PlanLifecyclePayload {
	planId: PlanId;
	sessionId?: SessionId;
}

const planningSource: EventSource = { type: "capability", id: "orchestration.plan" };

/** A plan was created and persisted (draft). */
export function planCreatedEvent(payload: PlanLifecyclePayload): PlatformEvent {
	return createEvent(EVENT_PLAN_CREATED, payload, { source: planningSource, scope: EventScope.Workspace });
}

/** A plan passed the user approval gate (status → approved). */
export function planApprovedEvent(payload: PlanLifecyclePayload): PlatformEvent {
	return createEvent(EVENT_PLAN_APPROVED, payload, { source: planningSource, scope: EventScope.Workspace });
}

/** A plan entered replanning (a subtree rewrite was requested). */
export function planReplanningEvent(payload: PlanLifecyclePayload): PlatformEvent {
	return createEvent(EVENT_PLAN_REPLANNING, payload, { source: planningSource, scope: EventScope.Workspace });
}

/** A plan finished executing (status → completed). */
export function planCompletedEvent(payload: PlanLifecyclePayload): PlatformEvent {
	return createEvent(EVENT_PLAN_COMPLETED, payload, { source: planningSource, scope: EventScope.Workspace });
}
