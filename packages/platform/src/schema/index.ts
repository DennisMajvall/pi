/**
 * Runtime Schemas
 *
 * TypeBox schemas for the capability platform contracts.
 * Suitable for future runtime validation, serialization, and RPC framing.
 *
 * NOTE: This module exports schema CONSTANTS only. The canonical TypeScript
 * types (interfaces and branded identifiers) live in the sibling modules
 * (./capability, ./event, ./error, ./identifier). Derive schema types with
 * `Static<typeof XSchema>` at the consumer site when needed.
 */

import { type TSchema, Type } from "typebox";

// ============================================================================
// Shared primitives
// ============================================================================

/** Capability id: `<category>.<name>` */
export const CapabilityIdSchema = Type.String({
	pattern: "^[a-z]+(\\.[a-z][a-z0-9_-]*)+$",
	description: "Capability identifier in the form <category>.<name>",
	examples: ["tool.read", "command.compact", "model.anthropic"],
});

/** Semantic version (SemVer 2.0.0 subset) */
export const CapabilityVersionSchema = Type.String({
	pattern: "^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z-.]+)?(\\+[0-9A-Za-z-.]+)?$",
	description: "SemVer version of the capability",
	examples: ["1.2.3", "2.0.0-rc.1"],
});

// ============================================================================
// Capability contracts
// ============================================================================

/**
 * Capability category.
 * Mirrors the CapabilityCategory const object.
 */
export const CapabilityCategorySchema = Type.Union([
	Type.Literal("tool"),
	Type.Literal("command"),
	Type.Literal("prompt"),
	Type.Literal("context"),
	Type.Literal("model"),
	Type.Literal("theme"),
	Type.Literal("policy"),
	Type.Literal("executor"),
	Type.Literal("memory"),
	Type.Literal("orchestration"),
	Type.Literal("ui"),
	Type.Literal("event"),
]);

/**
 * Capability lifecycle state.
 */
export const CapabilityStateSchema = Type.Union([
	Type.Literal("discovered"),
	Type.Literal("registered"),
	Type.Literal("resolved"),
	Type.Literal("initialized"),
	Type.Literal("ready"),
	Type.Literal("active"),
	Type.Literal("unloading"),
	Type.Literal("unloaded"),
	Type.Literal("error"),
]);

/**
 * Service dependency list.
 */
export const RequiredServiceSchema = Type.Union([
	Type.Literal("settings"),
	Type.Literal("session"),
	Type.Literal("fs"),
	Type.Literal("process"),
	Type.Literal("network"),
	Type.Literal("auth"),
	Type.Literal("cache"),
	Type.Literal("events"),
	Type.Literal("permissions"),
	Type.Literal("logging"),
	Type.Literal("configuration"),
	Type.Literal("telemetry"),
]);

/**
 * Dependency on another capability.
 */
export const CapabilityDependencySchema = Type.Object(
	{
		id: CapabilityIdSchema,
		version: Type.String({ description: "SemVer range", examples: ["^1.0.0"] }),
		optional: Type.Optional(Type.Boolean({ description: "Whether this dependency is optional" })),
	},
	{ additionalProperties: false },
);

/**
 * Capability permissions - serializable permission declarations.
 */
export const CapabilityPermissionsSchema = Type.Object(
	{
		fs: Type.Optional(
			Type.Union([Type.Literal("none"), Type.Literal("read"), Type.Literal("write"), Type.Literal("full")]),
		),
		network: Type.Optional(
			Type.Union([Type.Literal("none"), Type.Literal("outbound"), Type.Literal("inbound"), Type.Literal("full")]),
		),
		process: Type.Optional(
			Type.Union([Type.Literal("none"), Type.Literal("spawn"), Type.Literal("exec"), Type.Literal("full")]),
		),
		config: Type.Optional(
			Type.Union([Type.Literal("none"), Type.Literal("read"), Type.Literal("write"), Type.Literal("full")]),
		),
		spawn: Type.Optional(
			Type.Union([Type.Literal("none"), Type.Literal("capability"), Type.Literal("subagent"), Type.Literal("full")]),
		),
	},
	{
		description: "Declared permissions for a capability. Runtime enforces these.",
		additionalProperties: true,
	},
);

/**
 * Compatibility constraints.
 */
export const CapabilityCompatibilitySchema = Type.Object(
	{
		runtime: Type.String({ description: "Required runtime version range", examples: [">=0.83.0"] }),
		peers: Type.Record(CapabilityIdSchema, Type.String({ description: "Peer capability version range" })),
	},
	{ additionalProperties: false },
);

/**
 * Human-readable metadata.
 */
export const CapabilityMetadataSchema = Type.Object(
	{
		name: Type.String(),
		description: Type.String(),
		tags: Type.Array(Type.String()),
		author: Type.Optional(Type.String()),
		homepage: Type.Optional(Type.String()),
		license: Type.Optional(Type.String()),
		icon: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

/**
 * Typed exports - serializable subset.
 * Function-typed fields (execute, expand, provide) are represented as
 * capability-specific declarations; the implementations are loaded at runtime.
 */
export const CapabilityProvidesSchema = Type.Object(
	{
		tool: Type.Optional(
			Type.Object({
				name: Type.String(),
				description: Type.String(),
				parameters: Type.Unknown({ description: "TypeBox JSON schema for tool parameters" }),
				promptSnippet: Type.Optional(Type.String()),
				promptGuidelines: Type.Optional(Type.Array(Type.String())),
			}),
		),
		command: Type.Optional(
			Type.Object({
				name: Type.String(),
				description: Type.String(),
				argumentHint: Type.Optional(Type.String()),
			}),
		),
		prompt: Type.Optional(
			Type.Object({
				name: Type.String(),
				description: Type.String(),
				argumentHint: Type.Optional(Type.String()),
			}),
		),
		context: Type.Optional(
			Type.Object({
				name: Type.String(),
				description: Type.String(),
			}),
		),
		model: Type.Optional(
			Type.Object({
				providerId: Type.String(),
				providerName: Type.String(),
				models: Type.Array(
					Type.Object({
						id: Type.String(),
						name: Type.String(),
						contextWindow: Type.Number(),
						reasoning: Type.Optional(Type.Boolean()),
						vision: Type.Optional(Type.Boolean()),
						maxOutputTokens: Type.Optional(Type.Number()),
					}),
				),
				authType: Type.Union([Type.Literal("api_key"), Type.Literal("oauth"), Type.Literal("none")]),
				authEnvVar: Type.Optional(Type.String()),
			}),
		),
		theme: Type.Optional(
			Type.Object({
				name: Type.String(),
				colors: Type.Record(Type.String(), Type.String()),
				editorTheme: Type.Optional(Type.String()),
				extends: Type.Optional(Type.String()),
			}),
		),
		policy: Type.Optional(
			Type.Object({
				name: Type.String(),
				type: Type.String(),
			}),
		),
		executor: Type.Optional(
			Type.Object({
				name: Type.String(),
			}),
		),
		memory: Type.Optional(
			Type.Object({
				name: Type.String(),
				scopes: Type.Array(
					Type.Union([
						Type.Literal("session"),
						Type.Literal("project"),
						Type.Literal("user"),
						Type.Literal("global"),
					]),
				),
			}),
		),
		orchestration: Type.Optional(
			Type.Object({
				name: Type.String(),
			}),
		),
		ui: Type.Optional(
			Type.Object({
				name: Type.String(),
				components: Type.Array(
					Type.Object({
						type: Type.Union([
							Type.Literal("widget"),
							Type.Literal("renderer"),
							Type.Literal("overlay"),
							Type.Literal("panel"),
							Type.Literal("custom"),
						]),
						key: Type.String(),
					}),
				),
			}),
		),
		event: Type.Optional(
			Type.Object({
				name: Type.String(),
				subscriptions: Type.Array(
					Type.Object({
						eventType: Type.String(),
						priority: Type.Optional(Type.Number()),
					}),
				),
			}),
		),
	},
	{
		description: "Serializable declaration of what the capability provides. Implementations are runtime-only.",
		additionalProperties: true,
	},
);

/**
 * Capability manifest - the canonical serializable capability declaration.
 * Contains enough metadata for runtime discovery WITHOUT loading the capability.
 */
export const CapabilityManifestSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1, { description: "Manifest schema version. Bump on breaking manifest changes." }),
		id: CapabilityIdSchema,
		version: CapabilityVersionSchema,
		category: CapabilityCategorySchema,
		provides: CapabilityProvidesSchema,
		requires: Type.Object(
			{
				services: Type.Array(RequiredServiceSchema),
				capabilities: Type.Array(CapabilityDependencySchema),
			},
			{ additionalProperties: false },
		),
		permissions: CapabilityPermissionsSchema,
		compatibility: CapabilityCompatibilitySchema,
		metadata: CapabilityMetadataSchema,
	},
	{
		description: "Static, JSON-serializable capability declaration. Discoverable without loading the implementation.",
		additionalProperties: false,
	},
);

/**
 * Capability feature flags.
 */
export const CapabilityFeatureFlagsSchema = Type.Record(
	Type.String(),
	Type.Union([Type.Boolean(), Type.String(), Type.Number()]),
);

/**
 * Capability configuration - per-capability runtime configuration.
 */
export const CapabilityConfigurationSchema = Type.Object(
	{
		settings: Type.Record(Type.String(), Type.Unknown(), { description: "Capability-specific settings" }),
		featureFlags: CapabilityFeatureFlagsSchema,
		permissions: CapabilityPermissionsSchema,
	},
	{ additionalProperties: false },
);

/**
 * Capability health.
 */
export const CapabilityHealthSchema = Type.Object(
	{
		status: Type.Union([
			Type.Literal("healthy"),
			Type.Literal("degraded"),
			Type.Literal("unhealthy"),
			Type.Literal("unknown"),
		]),
		lastCheck: Type.Number(),
		details: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

/**
 * Runtime capability info (manifest + state).
 */
export const RuntimeCapabilityInfoSchema = Type.Object(
	{
		manifest: CapabilityManifestSchema,
		state: CapabilityStateSchema,
		error: Type.Optional(Type.String()),
		loadedAt: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

// ============================================================================
// Event contracts
// ============================================================================

/**
 * Event source.
 */
export const EventSourceSchema = Type.Object(
	{
		type: Type.Union([
			Type.Literal("runtime"),
			Type.Literal("capability"),
			Type.Literal("service"),
			Type.Literal("host"),
			Type.Literal("user"),
			Type.Literal("system"),
		]),
		id: Type.String(),
		name: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

/**
 * Event priority.
 */
export const EventPrioritySchema = Type.Union([
	Type.Literal(0),
	Type.Literal(50),
	Type.Literal(100),
	Type.Literal(200),
]);

/**
 * Event scope.
 */
export const EventScopeSchema = Type.Union([
	Type.Literal("global"),
	Type.Literal("capability"),
	Type.Literal("session"),
	Type.Literal("workspace"),
	Type.Literal("runtime"),
	Type.Literal("directed"),
]);

/**
 * Event metadata.
 */
export const EventMetadataSchema = Type.Object(
	{
		timestamp: Type.Number({ description: "Unix ms" }),
		source: EventSourceSchema,
		priority: EventPrioritySchema,
		scope: EventScopeSchema,
		correlationId: Type.Optional(Type.String()),
		causationId: Type.Optional(Type.String()),
		tags: Type.Optional(Type.Array(Type.String())),
	},
	{
		description: "Metadata attached to every platform event",
		additionalProperties: true,
	},
);

/**
 * Platform event - the canonical serializable event envelope.
 */
export const PlatformEventSchema = Type.Object(
	{
		id: Type.String({ description: "Unique event id" }),
		type: Type.String({ description: "Namespaced event type, e.g. tool.executed" }),
		metadata: EventMetadataSchema,
		payload: Type.Unknown({ description: "Event payload" }),
	},
	{ additionalProperties: false },
);

// ============================================================================
// Error contracts
// ============================================================================

/**
 * Serialized platform error.
 */
export const PlatformErrorSchema = Type.Object(
	{
		name: Type.String(),
		message: Type.String(),
		code: Type.String(),
		status: Type.Number(),
		metadata: Type.Record(Type.String(), Type.Unknown()),
		timestamp: Type.Number(),
		errorId: Type.String(),
		stack: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

// ============================================================================
// Identifier schemas
// ============================================================================

/**
 * Service id.
 */
export const ServiceIdSchema = Type.String({ pattern: "^[a-z][a-z0-9-]*$" });

/**
 * Runtime id.
 */
export const RuntimeIdSchema = Type.String();

/**
 * Session id.
 */
export const SessionIdSchema = Type.String();

/**
 * Workspace id.
 */
export const WorkspaceIdSchema = Type.String();

/**
 * Event id.
 */
export const EventIdSchema = Type.String();

// ============================================================================
// Registry of all schemas (for tooling, codegen, RPC type definitions)
// ============================================================================

/**
 * Map of all canonical schemas by name.
 * Useful for generating API docs, validating cross-package payloads,
 * and future runtime validation tooling.
 */
export const PlatformSchemas = {
	CapabilityId: CapabilityIdSchema,
	CapabilityVersion: CapabilityVersionSchema,
	CapabilityCategory: CapabilityCategorySchema,
	CapabilityState: CapabilityStateSchema,
	CapabilityDependency: CapabilityDependencySchema,
	CapabilityPermissions: CapabilityPermissionsSchema,
	CapabilityCompatibility: CapabilityCompatibilitySchema,
	CapabilityMetadata: CapabilityMetadataSchema,
	CapabilityProvides: CapabilityProvidesSchema,
	CapabilityManifest: CapabilityManifestSchema,
	CapabilityFeatureFlags: CapabilityFeatureFlagsSchema,
	CapabilityConfiguration: CapabilityConfigurationSchema,
	CapabilityHealth: CapabilityHealthSchema,
	RuntimeCapabilityInfo: RuntimeCapabilityInfoSchema,
	EventSource: EventSourceSchema,
	EventPriority: EventPrioritySchema,
	EventScope: EventScopeSchema,
	EventMetadata: EventMetadataSchema,
	PlatformEvent: PlatformEventSchema,
	PlatformError: PlatformErrorSchema,
	ServiceId: ServiceIdSchema,
	RuntimeId: RuntimeIdSchema,
	SessionId: SessionIdSchema,
	WorkspaceId: WorkspaceIdSchema,
	EventId: EventIdSchema,
} as const satisfies Record<string, TSchema>;

export type PlatformSchemas = typeof PlatformSchemas;
