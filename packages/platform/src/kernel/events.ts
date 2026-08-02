/**
 * Walking-skeleton event helpers.
 *
 * Constructs platform events (Step 1.2 envelope) for kernel lifecycle stages.
 */

import type { CapabilityManifest } from "../capability/index.ts";
import type { EventSource, PlatformEvent } from "../event/index.ts";
import { createEvent, EventScope, eventType } from "../event/index.ts";
import type { CapabilityId } from "../identifier/index.ts";

export const EVENT_REGISTERED = eventType("capability.registered");
export const EVENT_UNREGISTERED = eventType("capability.unregistered");
export const EVENT_INITIALIZED = eventType("capability.initialized");
export const EVENT_READY = eventType("capability.ready");
export const EVENT_ERROR = eventType("capability.error");
export const EVENT_SHUTDOWN = eventType("capability.shutdown");

const registrySource: EventSource = { type: "runtime", id: "registry" };
const lifecycleSource: EventSource = { type: "runtime", id: "lifecycle" };

export function registeredEvent(manifest: CapabilityManifest): PlatformEvent {
	return createEvent(
		EVENT_REGISTERED,
		{
			capabilityId: manifest.id,
			version: manifest.version,
			category: manifest.category,
			manifest,
		},
		{
			source: registrySource,
			scope: EventScope.Runtime,
		},
	);
}

export function unregisteredEvent(id: CapabilityId): PlatformEvent {
	return createEvent(
		EVENT_UNREGISTERED,
		{ capabilityId: id },
		{
			source: registrySource,
			scope: EventScope.Runtime,
		},
	);
}

export function initializedEvent(id: CapabilityId): PlatformEvent {
	return createEvent(
		EVENT_INITIALIZED,
		{ capabilityId: id },
		{
			source: lifecycleSource,
			scope: EventScope.Runtime,
		},
	);
}

export function readyEvent(id: CapabilityId): PlatformEvent {
	return createEvent(
		EVENT_READY,
		{ capabilityId: id },
		{
			source: lifecycleSource,
			scope: EventScope.Runtime,
		},
	);
}

export function shutdownEvent(id: CapabilityId): PlatformEvent {
	return createEvent(
		EVENT_SHUTDOWN,
		{ capabilityId: id },
		{
			source: lifecycleSource,
			scope: EventScope.Runtime,
		},
	);
}

export function errorEvent(id: CapabilityId, phase: string, error: Error): PlatformEvent {
	return createEvent(
		EVENT_ERROR,
		{
			capabilityId: id,
			phase,
			error: error.message,
			stack: error.stack,
		},
		{
			source: lifecycleSource,
			scope: EventScope.Runtime,
		},
	);
}
