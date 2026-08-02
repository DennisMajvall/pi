/**
 * Capability Contracts
 *
 * Canonical definitions for the capability platform.
 * These types form the vocabulary that all capabilities, services, and runtimes share.
 */

import type { TSchema } from "typebox";
import type { PlatformEvent } from "../event/index.ts";
import type { CapabilityId, CapabilityVersion, SessionId } from "../identifier/index.ts";
import type { CapabilityRegistry } from "../runtime/index.ts";
import type {
	AuthService,
	CacheService,
	ConfigurationService,
	EventBusService,
	FileSystemService,
	LoggingService,
	NetworkService,
	PermissionService,
	ProcessService,
	SessionService,
	SettingsService,
	TelemetryService,
} from "../service/index.ts";

/**
 * High-level capability category for discovery, UI grouping, and policy.
 */
export const CapabilityCategory = {
	/** Executes an action, returns result (read, bash, edit, write, grep, find, ls) */
	Tool: "tool",
	/** User-invokable via slash command (/model, /compact, /login, extension commands) */
	Command: "command",
	/** Generates text for LLM context (/template, /skill) */
	Prompt: "prompt",
	/** Provides data to prompt builder (AGENTS.md, CLAUDE.md, git history, symbols) */
	Context: "context",
	/** LLM provider implementation (Anthropic, OpenAI, Ollama, custom) */
	Model: "model",
	/** Visual styling (JSON themes, editor themes) */
	Theme: "theme",
	/** Pluggable policy (compaction, retry, approval) */
	Policy: "policy",
	/** Code/execution environment (local bash, container, remote) */
	Executor: "executor",
	/** Persistent storage + retrieval (project memory, long-term memory) */
	Memory: "memory",
	/** Multi-step coordination (planning, task graph, orchestration) */
	Orchestration: "orchestration",
	/** TUI component contributions (custom widgets, renderers) */
	UI: "ui",
	/** Event handler registrations (declarative event → handler) */
	Event: "event",
} as const;

export type CapabilityCategory = (typeof CapabilityCategory)[keyof typeof CapabilityCategory];

/**
 * Capability lifecycle state.
 */
export const CapabilityState = {
	/** Discovered but not yet registered */
	Discovered: "discovered",
	/** Registered in registry, manifest validated */
	Registered: "registered",
	/** Dependencies resolved, initialization order determined */
	Resolved: "resolved",
	/** init() called, exports available */
	Initialized: "initialized",
	/** Ready for use, all hooks registered */
	Ready: "ready",
	/** Actively executing or being used */
	Active: "active",
	/** Shutdown initiated */
	Unloading: "unloading",
	/** Fully unloaded, exports removed */
	Unloaded: "unloaded",
	/** Error during lifecycle */
	Error: "error",
} as const;

export type CapabilityState = (typeof CapabilityState)[keyof typeof CapabilityState];

/**
 * Capability manifest - static declaration serializable to JSON.
 * Contains enough metadata for runtime discovery WITHOUT loading implementation.
 */
export interface CapabilityManifest {
	/** Unique capability identifier: `<category>.<name>` */
	id: CapabilityId;
	/** SemVer version of this capability */
	version: CapabilityVersion;
	/** Category for discovery and UI grouping */
	category: CapabilityCategory;
	/** What this capability provides (typed exports) */
	provides: CapabilityProvides;
	/** What this capability requires (services + peer capabilities) */
	requires: CapabilityRequires;
	/** Permissions this capability needs */
	permissions: CapabilityPermissions;
	/** Version compatibility constraints */
	compatibility: CapabilityCompatibility;
	/** Human-readable metadata */
	metadata: CapabilityMetadata;
}

/**
 * Typed exports that this capability provides.
 * Other capabilities and hosts consume these via the registry.
 */
export interface CapabilityProvides {
	/** Tool definition + execution */
	tool?: ToolCapabilityExport;
	/** Slash command */
	command?: CommandCapabilityExport;
	/** Prompt template/skill */
	prompt?: PromptCapabilityExport;
	/** Context provider */
	context?: ContextCapabilityExport;
	/** Model provider */
	model?: ModelCapabilityExport;
	/** Theme */
	theme?: ThemeCapabilityExport;
	/** Policy (compaction, retry, approval) */
	policy?: PolicyCapabilityExport;
	/** Executor environment */
	executor?: ExecutorCapabilityExport;
	/** Memory system */
	memory?: MemoryCapabilityExport;
	/** Orchestration */
	orchestration?: OrchestrationCapabilityExport;
	/** UI contribution */
	ui?: UICapabilityExport;
	/** Event handler */
	event?: EventCapabilityExport;
	/** Arbitrary custom exports */
	[key: string]: unknown;
}

/**
 * Services and capabilities this capability requires.
 */
export interface CapabilityRequires {
	/** Required platform services */
	services: RequiredService[];
	/** Required peer capabilities (by id) */
	capabilities: CapabilityDependency[];
}

/**
 * A required platform service.
 */
export type RequiredService =
	| "settings"
	| "session"
	| "fs"
	| "process"
	| "network"
	| "auth"
	| "cache"
	| "events"
	| "permissions"
	| "logging"
	| "configuration"
	| "telemetry";

/**
 * Dependency on another capability.
 */
export interface CapabilityDependency {
	/** Capability ID */
	id: CapabilityId;
	/** SemVer range */
	version: string;
	/** Whether this dependency is optional */
	optional?: boolean;
}

/**
 * Permissions required by this capability.
 * Runtime enforces these; user consent required for new permissions.
 */
export interface CapabilityPermissions {
	/** File system access */
	fs?: "none" | "read" | "write" | "full";
	/** Network access */
	network?: "none" | "outbound" | "inbound" | "full";
	/** Process spawning */
	process?: "none" | "spawn" | "exec" | "full";
	/** Configuration access */
	config?: "none" | "read" | "write" | "full";
	/** Subagent/capability spawning */
	spawn?: "none" | "capability" | "subagent" | "full";
	/** Custom permission keys (extensible) */
	[key: string]: unknown;
}

/**
 * Version compatibility constraints.
 */
export interface CapabilityCompatibility {
	/** Required runtime version range */
	runtime: string;
	/** Peer capability version constraints */
	peers: Record<CapabilityId, string>;
}

/**
 * Human-readable capability metadata.
 */
export interface CapabilityMetadata {
	/** Display name */
	name: string;
	/** Description */
	description: string;
	/** Search tags */
	tags: string[];
	/** Author */
	author?: string;
	/** Homepage URL */
	homepage?: string;
	/** License */
	license?: string;
	/** Icon (emoji or identifier) */
	icon?: string;
}

/**
 * Tool capability export.
 */
export interface ToolCapabilityExport {
	definition: ToolDefinition;
	execute: (args: unknown, ctx: ToolExecutionContext) => Promise<ToolResult>;
}

/**
 * Tool definition (compatible with pi-agent-core AgentTool).
 */
export interface ToolDefinition {
	name: string;
	description: string;
	parameters: TSchema; // TypeBox schema
	promptSnippet?: string;
	promptGuidelines?: string[];
	renderResult?: (result: ToolResult) => string;
}

/**
 * Context provided during tool execution.
 */
export interface ToolExecutionContext {
	/** Capability's own context */
	capability: CapabilityContext;
	/** Abort signal for cancellation */
	signal: AbortSignal;
	/** Session ID */
	sessionId: SessionId;
	/** Working directory */
	cwd: string;
	/** Additional metadata */
	metadata: Record<string, unknown>;
}

/**
 * Tool execution result.
 */
export interface ToolResult {
	success: boolean;
	output?: unknown;
	error?: string;
	isError?: boolean;
	metadata?: Record<string, unknown>;
}

/**
 * Command capability export.
 */
export interface CommandCapabilityExport {
	name: string;
	description: string;
	argumentHint?: string;
	execute: (args: string, ctx: CommandContext) => Promise<void>;
	getArgumentCompletions?: (prefix: string, ctx: CommandContext) => Promise<CompletionItem[]>;
}

/**
 * Context for command execution.
 */
export interface CommandContext {
	capability: CapabilityContext;
	sessionId: SessionId;
	cwd: string;
	signal: AbortSignal;
}

/**
 * Completion item for command arguments.
 */
export interface CompletionItem {
	value: string;
	label?: string;
	description?: string;
}

/**
 * Prompt capability export (templates, skills).
 */
export interface PromptCapabilityExport {
	name: string;
	description: string;
	argumentHint?: string;
	expand: (args: string, ctx: PromptContext) => Promise<string>;
}

/**
 * Context for prompt expansion.
 */
export interface PromptContext {
	capability: CapabilityContext;
	sessionId: SessionId;
	cwd: string;
}

/**
 * Context provider capability export.
 */
export interface ContextCapabilityExport {
	name: string;
	description: string;
	provide: (ctx: ContextProviderContext) => Promise<ContextData>;
}

/**
 * Context for context providers.
 */
export interface ContextProviderContext {
	capability: CapabilityContext;
	sessionId: SessionId;
	cwd: string;
	query?: string;
}

/**
 * Context data provided to prompt builder.
 */
export interface ContextData {
	content: string;
	priority?: number;
	metadata?: Record<string, unknown>;
}

/**
 * Model provider capability export.
 */
export interface ModelCapabilityExport {
	provider: ModelProviderDefinition;
}

/**
 * Model provider definition.
 */
export interface ModelProviderDefinition {
	id: string;
	name: string;
	models: ModelDefinition[];
	auth: ModelAuthConfig;
}

/**
 * Model definition.
 */
export interface ModelDefinition {
	id: string;
	name: string;
	contextWindow: number;
	reasoning?: boolean;
	vision?: boolean;
	maxOutputTokens?: number;
	pricing?: ModelPricing;
}

/**
 * Model pricing info.
 */
export interface ModelPricing {
	inputPer1k?: number;
	outputPer1k?: number;
	currency?: string;
}

/**
 * Model authentication config.
 */
export interface ModelAuthConfig {
	type: "api_key" | "oauth" | "none";
	envVar?: string;
	oauthConfig?: OAuthConfig;
}

/**
 * OAuth configuration.
 */
export interface OAuthConfig {
	clientId: string;
	authUrl: string;
	tokenUrl: string;
	scopes: string[];
}

/**
 * Theme capability export.
 */
export interface ThemeCapabilityExport {
	name: string;
	theme: ThemeDefinition;
}

/**
 * Theme definition.
 */
export interface ThemeDefinition {
	name: string;
	colors: Record<string, string>;
	editorTheme?: string;
	extends?: string;
}

/**
 * Policy capability export.
 */
export interface PolicyCapabilityExport {
	name: string;
	type: "compaction" | "retry" | "approval" | string;
	evaluate: (input: PolicyInput, ctx: PolicyContext) => Promise<PolicyResult>;
}

/**
 * Policy input.
 */
export interface PolicyInput {
	[key: string]: unknown;
}

/**
 * Policy context.
 */
export interface PolicyContext {
	capability: CapabilityContext;
	sessionId: SessionId;
}

/**
 * Policy result.
 */
export interface PolicyResult {
	decision: "allow" | "deny" | "modify" | "defer";
	modifiedInput?: PolicyInput;
	reason?: string;
}

/**
 * Executor capability export.
 */
export interface ExecutorCapabilityExport {
	name: string;
	execute: (command: ExecutorCommand, ctx: ExecutorContext) => Promise<ExecutorResult>;
}

/**
 * Executor command.
 */
export interface ExecutorCommand {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	timeout?: number;
}

/**
 * Executor context.
 */
export interface ExecutorContext {
	capability: CapabilityContext;
	sessionId: SessionId;
	signal: AbortSignal;
}

/**
 * Executor result.
 */
export interface ExecutorResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut?: boolean;
}

/**
 * Memory capability export.
 */
export interface MemoryCapabilityExport {
	name: string;
	store: (key: string, value: unknown, ctx: MemoryContext) => Promise<void>;
	retrieve: (key: string, ctx: MemoryContext) => Promise<unknown | undefined>;
	query: (query: MemoryQuery, ctx: MemoryContext) => Promise<MemoryResult[]>;
	delete: (key: string, ctx: MemoryContext) => Promise<void>;
}

/**
 * Memory context.
 */
export interface MemoryContext {
	capability: CapabilityContext;
	sessionId: SessionId;
	scope: "session" | "project" | "user" | "global";
}

/**
 * Memory query.
 */
export interface MemoryQuery {
	text?: string;
	tags?: string[];
	limit?: number;
	offset?: number;
}

/**
 * Memory result.
 */
export interface MemoryResult {
	key: string;
	value: unknown;
	score?: number;
	metadata?: Record<string, unknown>;
}

/**
 * Orchestration capability export.
 */
export interface OrchestrationCapabilityExport {
	name: string;
	plan: (goal: string, ctx: OrchestrationContext) => Promise<Plan>;
	execute: (plan: Plan, ctx: OrchestrationContext) => Promise<ExecutionResult>;
}

/**
 * Orchestration context.
 */
export interface OrchestrationContext {
	capability: CapabilityContext;
	sessionId: SessionId;
	signal: AbortSignal;
}

/**
 * Plan definition.
 */
export interface Plan {
	steps: PlanStep[];
	metadata?: Record<string, unknown>;
}

/**
 * Plan step.
 */
export interface PlanStep {
	id: string;
	capability: CapabilityId;
	action: string;
	input: Record<string, unknown>;
	dependsOn?: string[];
}

/**
 * Execution result.
 */
export interface ExecutionResult {
	success: boolean;
	results: Record<string, unknown>;
	error?: string;
}

/**
 * UI contribution capability export.
 */
export interface UICapabilityExport {
	name: string;
	components: UIComponentDefinition[];
}

/**
 * UI component definition.
 */
export interface UIComponentDefinition {
	type: "widget" | "renderer" | "overlay" | "panel" | "custom";
	key: string;
	factory: (ctx: UIContext) => UIComponentInstance;
}

/**
 * UI context for component factories.
 */
export interface UIContext {
	capability: CapabilityContext;
	theme: ThemeDefinition;
}

/**
 * UI component instance.
 */
export interface UIComponentInstance {
	render: () => unknown; // TUI component
	dispose?: () => void;
}

/**
 * Event handler capability export.
 */
export interface EventCapabilityExport {
	name: string;
	subscriptions: CapabilityEventSubscription[];
}

/**
 * Event subscription declared by a capability.
 * Distinct from the event bus subscription handle in the event contracts.
 */
export interface CapabilityEventSubscription {
	eventType: string;
	handler: (event: PlatformEvent, ctx: CapabilityContext) => Promise<void>;
	filter?: (event: PlatformEvent) => boolean;
	priority?: number;
}

/**
 * Capability context - injected into every capability at initialization.
 * Mediates all access to services, peer capabilities, and platform features.
 */
export interface CapabilityContext {
	// Core services
	readonly settings: SettingsService;
	readonly session: SessionService;
	readonly fs: FileSystemService;
	readonly process: ProcessService;
	readonly network: NetworkService;
	readonly auth: AuthService;
	readonly cache: CacheService;
	readonly events: EventBusService;
	readonly permissions: PermissionService;
	readonly logging: LoggingService;
	readonly configuration: ConfigurationService;
	readonly telemetry: TelemetryService;

	// Capability registry
	readonly capabilities: CapabilityRegistry;

	// Metadata
	readonly capabilityId: CapabilityId;
	readonly capabilityVersion: CapabilityVersion;
	readonly sourceInfo: SourceInfo;
}

/**
 * Source information for a capability.
 */
export interface SourceInfo {
	/** Source type */
	type: "builtin" | "inline" | "file" | "npm" | "git" | "sdk";
	/** Source path or identifier */
	path: string;
	/** Package name if npm */
	packageName?: string;
	/** Git ref if git */
	gitRef?: string;
}

/**
 * Capability exports returned from init().
 */
export interface CapabilityExports {
	/** The capability's typed exports */
	[key: string]: unknown;
}

/**
 * Capability lifecycle interface.
 * Implement this to participate in the capability lifecycle.
 */
export interface CapabilityLifecycle {
	/** Initialize the capability. Called once after dependencies are ready. */
	init(ctx: CapabilityContext): Promise<CapabilityExports>;
	/** Shutdown the capability. Called during unload. */
	shutdown?(ctx: CapabilityContext): Promise<void>;
	/** Optional: Called when a session starts */
	onSessionStart?(ctx: CapabilityContext, event: SessionStartEvent): Promise<void>;
	/** Optional: Called when a session ends */
	onSessionEnd?(ctx: CapabilityContext, event: SessionEndEvent): Promise<void>;
	/** Optional: Called when configuration changes */
	onConfigChange?(ctx: CapabilityContext, changes: ConfigChanges): Promise<void>;
}

/**
 * Session start event.
 */
export interface SessionStartEvent {
	sessionId: SessionId;
	cwd: string;
	isNew: boolean;
}

/**
 * Session end event.
 */
export interface SessionEndEvent {
	sessionId: SessionId;
	reason: "closed" | "forked" | "replaced" | "error";
}

/**
 * Configuration changes.
 */
export interface ConfigChanges {
	changed: string[];
	previous: Record<string, unknown>;
	current: Record<string, unknown>;
}

/**
 * Configuration for a capability instance.
 */
export interface CapabilityConfiguration {
	/** Capability-specific settings */
	settings: Record<string, unknown>;
	/** Feature flags */
	featureFlags: CapabilityFeatureFlags;
	/** Permission grants */
	permissions: CapabilityPermissions;
}

/**
 * Feature flags for a capability.
 */
export interface CapabilityFeatureFlags {
	[key: string]: boolean | string | number;
}

/**
 * Capability health status.
 */
export interface CapabilityHealth {
	status: CapabilityStatus;
	lastCheck: number;
	details?: Record<string, unknown>;
}

/**
 * Capability status.
 */
export const CapabilityStatus = {
	Healthy: "healthy",
	Degraded: "degraded",
	Unhealthy: "unhealthy",
	Unknown: "unknown",
} as const;

export type CapabilityStatus = (typeof CapabilityStatus)[keyof typeof CapabilityStatus];

/**
 * Runtime capability info (manifest + runtime state).
 */
export interface RuntimeCapabilityInfo {
	manifest: CapabilityManifest;
	state: CapabilityState;
	exports?: CapabilityExports;
	health?: CapabilityHealth;
	error?: string;
	loadedAt?: number;
}
