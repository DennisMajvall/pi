/**
 * Shared Identifiers
 *
 * Branded identifier types for the capability platform.
 * Replaces raw strings with type-safe branded types.
 * NO RUNTIME BEHAVIOR - type definitions only.
 */

/**
 * Creates a branded type from a string.
 * @internal
 */
type Brand<T> = T & { readonly __brand: unique symbol };

/**
 * Cast a string to a branded identifier.
 * @internal
 */
function brand<T extends Brand<string>>(value: string): T {
	return value as T;
}

/**
 * Capability identifier.
 * Format: `<category>.<name>` e.g., "tool.read", "command.compact", "model.anthropic"
 */
export type CapabilityId = Brand<string>;

/** Create a CapabilityId from a string */
export function capabilityId(id: string): CapabilityId {
	return brand<CapabilityId>(id);
}

/** Check if a string is a valid CapabilityId format */
export function isCapabilityId(value: string): value is CapabilityId {
	return /^[a-z]+(\.[a-z][a-z0-9_-]*)+$/i.test(value);
}

/** Parse a CapabilityId into category and name */
export function parseCapabilityId(id: CapabilityId): { category: string; name: string } {
	const [category, ...nameParts] = id.split(".");
	return { category, name: nameParts.join(".") };
}

/**
 * Capability version (SemVer).
 */
export type CapabilityVersion = Brand<string>;

export function capabilityVersion(version: string): CapabilityVersion {
	return brand<CapabilityVersion>(version);
}

/**
 * Event identifier.
 */
export type EventId = Brand<string>;

export function eventId(id?: string): EventId {
	return brand<EventId>(id ?? crypto.randomUUID());
}

/**
 * Service identifier.
 */
export type ServiceId = Brand<string>;

export function serviceId(id: string): ServiceId {
	return brand<ServiceId>(id);
}

/**
 * Runtime identifier.
 */
export type RuntimeId = Brand<string>;

export function runtimeId(id?: string): RuntimeId {
	return brand<RuntimeId>(id ?? crypto.randomUUID());
}

/**
 * Workspace identifier.
 */
export type WorkspaceId = Brand<string>;

export function workspaceId(id: string): WorkspaceId {
	return brand<WorkspaceId>(id);
}

/**
 * Session identifier.
 */
export type SessionId = Brand<string>;

export function sessionId(id?: string): SessionId {
	return brand<SessionId>(id ?? crypto.randomUUID());
}

/**
 * User identifier.
 */
export type UserId = Brand<string>;

export function userId(id: string): UserId {
	return brand<UserId>(id);
}

/**
 * Project identifier.
 */
export type ProjectId = Brand<string>;

export function projectId(id: string): ProjectId {
	return brand<ProjectId>(id);
}

/**
 * Tool identifier.
 * Alias for CapabilityId with category "tool".
 */
export type ToolId = CapabilityId & Brand<string>;

export function toolId(id: string): ToolId {
	if (!id.startsWith("tool.")) {
		throw new Error(`ToolId must start with "tool.": ${id}`);
	}
	return brand<ToolId>(id);
}

/**
 * Command identifier.
 * Alias for CapabilityId with category "command".
 */
export type CommandId = CapabilityId & Brand<string>;

export function commandId(id: string): CommandId {
	if (!id.startsWith("command.")) {
		throw new Error(`CommandId must start with "command.": ${id}`);
	}
	return brand<CommandId>(id);
}

/**
 * Model identifier.
 * Format: `<provider>/<model>` e.g., "anthropic/claude-opus-4"
 */
export type ModelId = Brand<string>;

export function modelId(id: string): ModelId {
	return brand<ModelId>(id);
}

export function parseModelId(id: ModelId): { provider: string; model: string } {
	const [provider, ...modelParts] = id.split("/");
	return { provider, model: modelParts.join("/") };
}

/**
 * Provider identifier.
 */
export type ProviderId = Brand<string>;

export function providerId(id: string): ProviderId {
	return brand<ProviderId>(id);
}

/**
 * Extension identifier.
 * For npm packages, git repos, or local paths.
 */
export type ExtensionId = Brand<string>;

export function extensionId(id: string): ExtensionId {
	return brand<ExtensionId>(id);
}

/**
 * Theme identifier.
 */
export type ThemeId = CapabilityId & Brand<string>;

export function themeId(id: string): ThemeId {
	if (!id.startsWith("theme.")) {
		throw new Error(`ThemeId must start with "theme.": ${id}`);
	}
	return brand<ThemeId>(id);
}

/**
 * Skill identifier.
 */
export type SkillId = CapabilityId & Brand<string>;

export function skillId(id: string): SkillId {
	if (!id.startsWith("skill.")) {
		throw new Error(`SkillId must start with "skill.": ${id}`);
	}
	return brand<SkillId>(id);
}

/**
 * Prompt template identifier.
 */
export type PromptTemplateId = CapabilityId & Brand<string>;

export function promptTemplateId(id: string): PromptTemplateId {
	if (!id.startsWith("prompt.")) {
		throw new Error(`PromptTemplateId must start with "prompt.": ${id}`);
	}
	return brand<PromptTemplateId>(id);
}

/**
 * Configuration key.
 * Dot-notation path e.g., "model.defaultProvider", "tools.excluded"
 */
export type ConfigKey = Brand<string>;

export function configKey(key: string): ConfigKey {
	return brand<ConfigKey>(key);
}

/**
 * Permission key.
 * Format: `<resource>.<action>` e.g., "fs.read", "network.outbound"
 */
export type PermissionKey = Brand<string>;

export function permissionKey(key: string): PermissionKey {
	return brand<PermissionKey>(key);
}

/**
 * Feature flag key.
 */
export type FeatureFlagKey = Brand<string>;

export function featureFlagKey(key: string): FeatureFlagKey {
	return brand<FeatureFlagKey>(key);
}

/**
 * Tag identifier.
 */
export type TagId = Brand<string>;

export function tagId(id: string): TagId {
	return brand<TagId>(id);
}

/**
 * Label identifier.
 */
export type LabelId = Brand<string>;

export function labelId(id: string): LabelId {
	return brand<LabelId>(id);
}

/**
 * Branch identifier (for session branching).
 */
export type BranchId = Brand<string>;

export function branchId(id?: string): BranchId {
	return brand<BranchId>(id ?? crypto.randomUUID());
}

/**
 * Entry identifier (session entry).
 */
export type EntryId = Brand<string>;

export function entryId(id?: string): EntryId {
	return brand<EntryId>(id ?? crypto.randomUUID());
}

/**
 * Correlation identifier (for event tracing).
 */
export type CorrelationId = Brand<string>;

export function correlationId(id?: string): CorrelationId {
	return brand<CorrelationId>(id ?? crypto.randomUUID());
}

/**
 * Causation identifier (event that caused another).
 */
export type CausationId = EventId;

/**
 * Request identifier (for RPC/request tracking).
 */
export type RequestId = Brand<string>;

export function requestId(id?: string): RequestId {
	return brand<RequestId>(id ?? crypto.randomUUID());
}

/**
 * Task identifier (for orchestration).
 */
export type TaskId = Brand<string>;

export function taskId(id?: string): TaskId {
	return brand<TaskId>(id ?? crypto.randomUUID());
}

/**
 * Plan identifier.
 */
export type PlanId = Brand<string>;

export function planId(id?: string): PlanId {
	return brand<PlanId>(id ?? crypto.randomUUID());
}

/**
 * Step identifier (plan step).
 */
export type StepId = Brand<string>;

export function stepId(id?: string): StepId {
	return brand<StepId>(id ?? crypto.randomUUID());
}

/**
 * Worker identifier (background workers).
 */
export type WorkerId = Brand<string>;

export function workerId(id?: string): WorkerId {
	return brand<WorkerId>(id ?? crypto.randomUUID());
}

/**
 * Subagent identifier.
 */
export type SubagentId = Brand<string>;

export function subagentId(id?: string): SubagentId {
	return brand<SubagentId>(id ?? crypto.randomUUID());
}

/**
 * Memory namespace/key.
 */
export type MemoryKey = Brand<string>;

export function memoryKey(key: string): MemoryKey {
	return brand<MemoryKey>(key);
}

/**
 * Cache key.
 */
export type CacheKey = Brand<string>;

export function cacheKey(key: string): CacheKey {
	return brand<CacheKey>(key);
}

/**
 * Lock identifier (for distributed locking).
 */
export type LockId = Brand<string>;

export function lockId(id: string): LockId {
	return brand<LockId>(id);
}

/**
 * All branded identifier types for convenience.
 */
export type AnyId =
	| CapabilityId
	| EventId
	| ServiceId
	| RuntimeId
	| WorkspaceId
	| SessionId
	| UserId
	| ProjectId
	| ToolId
	| CommandId
	| ModelId
	| ProviderId
	| ExtensionId
	| ThemeId
	| SkillId
	| PromptTemplateId
	| ConfigKey
	| PermissionKey
	| FeatureFlagKey
	| TagId
	| LabelId
	| BranchId
	| EntryId
	| CorrelationId
	| RequestId
	| TaskId
	| PlanId
	| StepId
	| WorkerId
	| SubagentId
	| MemoryKey
	| CacheKey
	| LockId;

/**
 * Type guard for AnyId.
 */
export function isAnyId(value: unknown): value is AnyId {
	return typeof value === "string" && value.length > 0;
}
