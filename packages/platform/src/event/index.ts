/**
 * Event Contracts
 *
 * Platform event model for the capability platform.
 * Defines the structure, metadata, and conventions for all events.
 * NO IMPLEMENTATIONS - types and interfaces only.
 */

import type { CapabilityId, EventId, RuntimeId, SessionId, WorkspaceId } from "../identifier/index.ts";
import { eventId } from "../identifier/index.ts";

/**
 * Base platform event.
 * All events in the platform extend this.
 */
export interface PlatformEvent {
	/** Unique event identifier */
	id: EventId;

	/** Event type (namespaced: "capability.tool.executed", "session.created") */
	type: EventType;

	/** Event metadata */
	metadata: EventMetadata;

	/** Event payload */
	payload: unknown;
}

/**
 * Event type - namespaced string for categorization.
 * Format: `<domain>.<action>` e.g., "tool.executed", "session.forked", "capability.registered"
 */
export type EventType = string & { readonly __brand: unique symbol };

/**
 * Creates an event type from a string.
 */
export function eventType(type: string): EventType {
	return type as EventType;
}

/**
 * Event metadata - attached to every event.
 */
export interface EventMetadata {
	/** When the event occurred (Unix ms) */
	timestamp: number;

	/** Source of the event */
	source: EventSource;

	/** Event priority */
	priority: EventPriority;

	/** Event scope (who should receive) */
	scope: EventScope;

	/** Correlation ID for tracing related events */
	correlationId?: EventId;

	/** Causation ID (event that caused this) */
	causationId?: EventId;

	/** Tags for filtering */
	tags?: string[];

	/** Additional metadata */
	[key: string]: unknown;
}

/**
 * Event source.
 */
export interface EventSource {
	/** Source type */
	type: "runtime" | "capability" | "service" | "host" | "user" | "system";

	/** Source identifier */
	id: CapabilityId | RuntimeId | "runtime" | string;

	/** Human-readable name */
	name?: string;
}

/**
 * Event priority.
 */
export const EventPriority = {
	/** Background, non-critical */
	Low: 0,

	/** Normal priority */
	Normal: 50,

	/** High priority, should be processed quickly */
	High: 100,

	/** Critical, blocks other processing */
	Critical: 200,
} as const;

export type EventPriority = (typeof EventPriority)[keyof typeof EventPriority];

/**
 * Event scope - determines delivery.
 */
export const EventScope = {
	/** Global - all subscribers */
	Global: "global",

	/** Capability-scoped - only that capability's subscribers */
	Capability: "capability",

	/** Session-scoped - only subscribers in that session */
	Session: "session",

	/** Workspace-scoped - only subscribers in that workspace */
	Workspace: "workspace",

	/** Runtime-scoped - only subscribers in that runtime */
	Runtime: "runtime",

	/** Directed - specific target */
	Directed: "directed",
} as const;

export type EventScope = (typeof EventScope)[keyof typeof EventScope];

/**
 * Core platform event types (constants for common events).
 */
export const PlatformEventType = {
	// Capability lifecycle
	CapabilityRegistered: eventType("capability.registered"),
	CapabilityUnregistered: eventType("capability.unregistered"),
	CapabilityInitialized: eventType("capability.initialized"),
	CapabilityReady: eventType("capability.ready"),
	CapabilityError: eventType("capability.error"),
	CapabilityShutdown: eventType("capability.shutdown"),

	// Tool events
	ToolExecuted: eventType("tool.executed"),
	ToolStarted: eventType("tool.started"),
	ToolCompleted: eventType("tool.completed"),
	ToolFailed: eventType("tool.failed"),

	// Command events
	CommandExecuted: eventType("command.executed"),
	CommandCompleted: eventType("command.completed"),
	CommandFailed: eventType("command.failed"),

	// Session events
	SessionCreated: eventType("session.created"),
	SessionOpened: eventType("session.opened"),
	SessionClosed: eventType("session.closed"),
	SessionForked: eventType("session.forked"),
	SessionImported: eventType("session.imported"),
	SessionExported: eventType("session.exported"),

	// Model events
	ModelSelected: eventType("model.selected"),
	ModelSwitched: eventType("model.switched"),
	ModelStreamStarted: eventType("model.stream.started"),
	ModelStreamChunk: eventType("model.stream.chunk"),
	ModelStreamEnded: eventType("model.stream.ended"),

	// Prompt events
	PromptExpanded: eventType("prompt.expanded"),
	SkillInvoked: eventType("skill.invoked"),
	TemplateExpanded: eventType("template.expanded"),

	// Context events
	ContextProvided: eventType("context.provided"),
	ContextFilesLoaded: eventType("context.files.loaded"),

	// Compaction events
	CompactionStarted: eventType("compaction.started"),
	CompactionCompleted: eventType("compaction.completed"),
	CompactionFailed: eventType("compaction.failed"),
	BranchSummaryGenerated: eventType("branch.summary.generated"),

	// Settings events
	SettingsChanged: eventType("settings.changed"),
	SettingsLoaded: eventType("settings.loaded"),
	SettingsSaved: eventType("settings.saved"),

	// Permission events
	PermissionRequested: eventType("permission.requested"),
	PermissionGranted: eventType("permission.granted"),
	PermissionDenied: eventType("permission.denied"),
	PermissionRevoked: eventType("permission.revoked"),

	// Extension events (for backwards compatibility)
	ExtensionLoaded: eventType("extension.loaded"),
	ExtensionUnloaded: eventType("extension.unloaded"),
	ExtensionError: eventType("extension.error"),

	// Host events
	HostStarted: eventType("host.started"),
	HostStopped: eventType("host.stopped"),
	HostError: eventType("host.error"),

	// System events
	StartupComplete: eventType("system.startup_complete"),
	ShutdownInitiated: eventType("system.shutdown_initiated"),
	Error: eventType("system.error"),
} as const;

/**
 * Payload types for core events.
 */

// Capability events
export interface CapabilityRegisteredPayload {
	capabilityId: CapabilityId;
	version: string;
	category: string;
	manifest: unknown; // CapabilityManifest
}

export interface CapabilityErrorPayload {
	capabilityId: CapabilityId;
	phase: string;
	error: string;
	stack?: string;
}

// Tool events
export interface ToolExecutedPayload {
	toolName: string;
	capabilityId: CapabilityId;
	sessionId: SessionId;
	args: unknown;
	result: ToolExecutionResult;
	durationMs: number;
}

export interface ToolExecutionResult {
	success: boolean;
	output?: unknown;
	error?: string;
	isError?: boolean;
}

// Command events
export interface CommandExecutedPayload {
	commandName: string;
	capabilityId: CapabilityId;
	sessionId: SessionId;
	args: string;
	result: CommandResult;
}

export interface CommandResult {
	success: boolean;
	output?: string;
	error?: string;
}

// Session events
export interface SessionCreatedPayload {
	sessionId: SessionId;
	workspaceId: WorkspaceId;
	cwd: string;
	parentSessionId?: SessionId;
}

export interface SessionForkedPayload {
	sourceSessionId: SessionId;
	newSessionId: SessionId;
	entryId: string;
	label?: string;
}

// Model events
export interface ModelSelectedPayload {
	provider: string;
	modelId: string;
	sessionId: SessionId;
	thinkingLevel?: string;
}

export interface ModelStreamChunkPayload {
	sessionId: SessionId;
	chunk: unknown; // AssistantMessageEvent
	isComplete: boolean;
}

// Prompt events
export interface SkillInvokedPayload {
	skillName: string;
	capabilityId: CapabilityId;
	sessionId: SessionId;
	args: string;
	expandedLength: number;
}

export interface TemplateExpandedPayload {
	templateName: string;
	capabilityId: CapabilityId;
	sessionId: SessionId;
	args: string;
	expandedLength: number;
}

// Context events
export interface ContextProvidedPayload {
	capabilityId: CapabilityId;
	sessionId: SessionId;
	contextName: string;
	contentLength: number;
	priority: number;
}

// Compaction events
export interface CompactionStartedPayload {
	sessionId: SessionId;
	reason: "manual" | "threshold" | "overflow";
	estimatedTokens: number;
}

export interface CompactionCompletedPayload {
	sessionId: SessionId;
	reason: "manual" | "threshold" | "overflow";
	originalTokens: number;
	compactedTokens: number;
	durationMs: number;
	success: boolean;
}

// Settings events
export interface SettingsChangedPayload {
	changes: Array<{
		path: string;
		previous: unknown;
		current: unknown;
		scope: "global" | "project" | "user";
	}>;
}

// Permission events
export interface PermissionRequestedPayload {
	capabilityId: CapabilityId;
	permission: string;
	reason: string;
	required: boolean;
}

export interface PermissionGrantedPayload {
	capabilityId: CapabilityId;
	permission: string;
	grantedBy: "user" | "config" | "default";
}

export interface PermissionDeniedPayload {
	capabilityId: CapabilityId;
	permission: string;
	reason: string;
}

// Extension events (backwards compatibility)
export interface ExtensionLoadedPayload {
	extensionPath: string;
	extensionName: string;
	tools: string[];
	commands: string[];
}

// System events
export interface SystemErrorPayload {
	source: EventSource;
	error: string;
	stack?: string;
	severity: "warning" | "error" | "fatal";
}

/**
 * Event factory functions for creating typed events.
 */

export function createEvent<T extends PlatformEvent>(
	type: EventType,
	payload: T["payload"],
	options?: {
		source?: EventSource;
		priority?: EventPriority;
		scope?: EventScope;
		correlationId?: EventId;
		causationId?: EventId;
		tags?: string[];
	},
): T {
	const now = Date.now();
	return {
		id: eventId(),
		type,
		payload,
		metadata: {
			timestamp: now,
			source: options?.source ?? { type: "system", id: "runtime" },
			priority: options?.priority ?? EventPriority.Normal,
			scope: options?.scope ?? EventScope.Global,
			correlationId: options?.correlationId,
			causationId: options?.causationId,
			tags: options?.tags,
		},
	} as T;
}

/**
 * Type guard for checking event type.
 */
export function isEventType<T extends PlatformEvent>(event: PlatformEvent, type: EventType): event is T {
	return event.type === type;
}

/**
 * Event filter function type.
 */
export type EventFilter = (event: PlatformEvent) => boolean;

/**
 * Event subscription handle.
 */
export interface EventSubscription {
	/** Unsubscribe */
	unsubscribe(): void;

	/** Event type this subscription is for */
	readonly eventType: EventType;

	/** Subscription options */
	readonly options: SubscribeOptions;
}

/**
 * Subscribe options.
 */
export interface SubscribeOptions {
	filter?: EventFilter;
	priority?: number;
	replay?: boolean;
}

/**
 * Event bus statistics.
 */
export interface EventBusStats {
	totalEvents: number;
	eventsByType: Record<string, number>;
	activeSubscriptions: number;
	historySize: number;
}
