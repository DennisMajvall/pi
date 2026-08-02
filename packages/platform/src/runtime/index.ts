/**
 * Runtime Contracts
 *
 * Core interfaces for the capability platform runtime (kernel).
 * These define the boundaries between the runtime, services, capabilities, and hosts.
 * NO IMPLEMENTATIONS - interfaces only.
 */

import type {
	CapabilityCategory,
	CapabilityContext,
	CapabilityDependency,
	CapabilityExports,
	CapabilityLifecycle,
	CapabilityManifest,
	CapabilityState,
	RuntimeCapabilityInfo,
} from "../capability/index.ts";
import type { CapabilityId, CapabilityVersion, RuntimeId, SessionId, WorkspaceId } from "../identifier/index.ts";
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
 * The platform runtime (kernel).
 * Owns the capability registry, event bus, lifecycle manager, and services.
 * Does NOT execute business logic.
 */
export interface Runtime {
	/** Unique runtime identifier */
	readonly id: RuntimeId;

	/** Capability registry */
	readonly capabilities: CapabilityRegistry;

	/** Event bus */
	readonly events: EventBusService;

	/** Service provider (access to all platform services) */
	readonly services: ServiceProvider;

	/** Initialize the runtime */
	initialize(): Promise<void>;

	/** Start the runtime (begin accepting capabilities) */
	start(): Promise<void>;

	/** Shutdown the runtime gracefully */
	shutdown(): Promise<void>;

	/** Get runtime health */
	health(): Promise<RuntimeHealth>;
}

/**
 * Runtime health status.
 */
export interface RuntimeHealth {
	status: "healthy" | "degraded" | "unhealthy";
	uptime: number;
	capabilities: {
		total: number;
		ready: number;
		error: number;
	};
	services: Record<string, "healthy" | "degraded" | "unhealthy">;
}

/**
 * Runtime context - provided to services and capabilities.
 * Read-only view of runtime capabilities.
 */
export interface RuntimeContext {
	readonly runtimeId: RuntimeId;
	readonly workspaceId: WorkspaceId;
	readonly sessionId: SessionId | undefined;
	readonly capabilities: CapabilityRegistry;
	readonly events: EventBusService;
	readonly services: ServiceProvider;
}

/**
 * Capability registry - manages capability discovery, registration, resolution.
 * Single source of truth for all capabilities in a runtime.
 */
export interface CapabilityRegistry {
	/** Register a capability from manifest and loader */
	register(manifest: CapabilityManifest, loader: CapabilityLoader): Promise<CapabilityRegistration>;

	/** Unregister a capability */
	unregister(id: CapabilityId): Promise<void>;

	/** Get capability info by ID */
	get(id: CapabilityId): RuntimeCapabilityInfo | undefined;

	/** Get all registered capabilities */
	getAll(): RuntimeCapabilityInfo[];

	/** Get capabilities by category */
	getByCategory(category: CapabilityCategory): RuntimeCapabilityInfo[];

	/** Get capability exports (for peer consumption) */
	getExports<T = unknown>(id: CapabilityId): T | undefined;

	/** Find capabilities matching a query */
	find(query: CapabilityQuery): RuntimeCapabilityInfo[];

	/** Subscribe to registry changes */
	subscribe(listener: RegistryListener): () => void;
}

/**
 * Capability registration result.
 */
export interface CapabilityRegistration {
	id: CapabilityId;
	version: CapabilityVersion;
	state: CapabilityState;
}

/**
 * Capability loader - knows how to load a capability implementation.
 * Separated from manifest to allow lazy loading.
 */
export interface CapabilityLoader {
	/** Load the capability implementation and return its lifecycle interface */
	load(ctx: CapabilityContext): Promise<CapabilityLifecycle>;

	/** Optional: Pre-load validation */
	validate?(manifest: CapabilityManifest): Promise<ValidationResult>;
}

/**
 * Validation result.
 */
export interface ValidationResult {
	valid: boolean;
	errors: string[];
	warnings: string[];
}

/**
 * Capability query for registry lookup.
 */
export interface CapabilityQuery {
	category?: CapabilityCategory;
	provides?: string; // key in CapabilityProvides
	requires?: CapabilityId;
	state?: CapabilityState;
	tags?: string[];
}

/**
 * Registry change listener.
 */
export interface RegistryListener {
	onRegistered(info: RuntimeCapabilityInfo): void;
	onUnregistered(id: CapabilityId): void;
	onStateChanged(info: RuntimeCapabilityInfo, previousState: CapabilityState): void;
	onError(id: CapabilityId, error: Error): void;
}

/**
 * Capability resolver - resolves dependency graphs and initialization order.
 */
export interface CapabilityResolver {
	/** Resolve dependencies for a set of capabilities */
	resolve(ids: CapabilityId[]): Promise<ResolvedCapabilityGraph>;

	/** Check for version conflicts */
	checkConflicts(ids: CapabilityId[]): Promise<VersionConflict[]>;
}

/**
 * Resolved capability graph with initialization order.
 */
export interface ResolvedCapabilityGraph {
	/** Capabilities in initialization order (dependencies first) */
	initializationOrder: CapabilityId[];
	/** Dependency edges */
	dependencies: Map<CapabilityId, CapabilityDependency[]>;
	/** Missing dependencies */
	missing: CapabilityDependency[];
	/** Circular dependencies detected */
	cycles: CapabilityId[][];
}

/**
 * Version conflict.
 */
export interface VersionConflict {
	capabilityId: CapabilityId;
	required: string;
	available: string;
	dependents: CapabilityId[];
}

/**
 * Capability discovery - finds capabilities from various sources.
 */
export interface CapabilityDiscovery {
	/** Discover capabilities from all configured sources */
	discover(): Promise<DiscoveredCapability[]>;

	/** Discover from a specific source */
	discoverFrom(source: CapabilitySource): Promise<DiscoveredCapability[]>;
}

/**
 * Discovered capability (before registration).
 */
export interface DiscoveredCapability {
	source: CapabilitySource;
	manifest: CapabilityManifest;
	loadSpec: CapabilityLoadSpec;
}

/**
 * Capability source.
 */
export interface CapabilitySource {
	type: "builtin" | "inline" | "file" | "npm" | "git" | "sdk" | "config";
	identifier: string; // path, package name, etc.
	metadata?: Record<string, unknown>;
}

/**
 * How to load a capability.
 */
export interface CapabilityLoadSpec {
	type: "factory" | "module" | "factory-module";
	/** For factory: the factory function */
	factory?: CapabilityFactory;
	/** For module: module specifier */
	moduleSpecifier?: string;
	/** For factory-module: module + export name */
	moduleExport?: string;
}

/**
 * Capability factory function (for inline/SDK capabilities).
 */
export type CapabilityFactory = (ctx: CapabilityContext) => Promise<CapabilityLifecycle>;

/**
 * Lifecycle manager - manages capability lifecycle transitions.
 */
export interface LifecycleManager {
	/** Initialize a registered capability */
	initialize(id: CapabilityId): Promise<CapabilityExports>;

	/** Shutdown a capability */
	shutdown(id: CapabilityId): Promise<void>;

	/** Restart a capability (shutdown + initialize) */
	restart(id: CapabilityId): Promise<CapabilityExports>;

	/** Get current lifecycle state */
	getState(id: CapabilityId): CapabilityState;

	/** Subscribe to lifecycle events */
	subscribe(listener: LifecycleListener): () => void;
}

/**
 * Lifecycle event listener.
 */
export interface LifecycleListener {
	onStateChange(id: CapabilityId, from: CapabilityState, to: CapabilityState): void;
	onError(id: CapabilityId, error: Error, phase: LifecyclePhase): void;
}

/**
 * Lifecycle phase.
 */
export const LifecyclePhase = {
	Initializing: "initializing",
	Initialized: "initialized",
	Ready: "ready",
	ShuttingDown: "shutting_down",
	Shutdown: "shutdown",
} as const;

export type LifecyclePhase = (typeof LifecyclePhase)[keyof typeof LifecyclePhase];

/**
 * Service provider - provides access to all platform services.
 * Capabilities receive a scoped view via CapabilityContext.
 */
export interface ServiceProvider {
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

	/** Get a service by ID (for dynamic access) */
	get<T extends keyof ServiceProvider>(id: T): ServiceProvider[T];
	get(id: string): unknown;
}
