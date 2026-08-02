/**
 * Platform Service Contracts
 *
 * Interfaces for all core platform services.
 * Services are infrastructure - they provide cross-cutting capabilities
 * to the runtime, capabilities, and hosts.
 * NO IMPLEMENTATIONS - interfaces only.
 */

import type { CapabilityConfiguration, CapabilityFeatureFlags, CapabilityPermissions } from "../capability/index.ts";
import type { PlatformEvent, SubscribeOptions } from "../event/index.ts";
import type { CapabilityId, PermissionKey, SessionId, WorkspaceId } from "../identifier/index.ts";
import type { ValidationResult } from "../runtime/index.ts";

/**
 * Settings service - manages global, project, and user configuration.
 * Handles migration, validation, change notification, and file locking.
 */
export interface SettingsService {
	/** Get a setting value by path (dot notation) */
	get<T>(path: string, defaultValue?: T): T | undefined;

	/** Set a setting value */
	set(path: string, value: unknown): Promise<void>;

	/** Get all settings as a plain object */
	getAll(): Record<string, unknown>;

	/** Register a settings schema for validation */
	registerSchema(schema: SettingsSchema): void;

	/** Subscribe to setting changes */
	subscribe(path: string, listener: (value: unknown, previous: unknown) => void): () => void;

	/** Subscribe to any setting change */
	subscribeAny(listener: (changes: SettingsChange[]) => void): () => void;

	/** Load settings from disk */
	load(): Promise<void>;

	/** Save settings to disk */
	save(): Promise<void>;

	/** Reset to defaults */
	reset(path?: string): Promise<void>;

	/** Get the settings file path for a scope */
	getSettingsPath(scope: "global" | "project" | "user"): string;
}

/**
 * Settings schema for validation.
 */
export interface SettingsSchema {
	/** Dot-notation path */
	path: string;
	/** TypeBox schema */
	schema: object; // TSchema
	/** Default value */
	default?: unknown;
	/** Description */
	description?: string;
	/** Scope */
	scope?: "global" | "project" | "user";
	/** Whether user can override */
	userOverridable?: boolean;
}

/**
 * Settings change event.
 */
export interface SettingsChange {
	path: string;
	previous: unknown;
	current: unknown;
	scope: "global" | "project" | "user";
}

/**
 * Session service - manages session persistence, branching, import/export.
 * Operates on JSONL v3 format with tree structure.
 */
export interface SessionService {
	/** Create a new session */
	create(options: CreateSessionOptions): Promise<Session>;

	/** Open an existing session */
	open(path: string): Promise<Session>;

	/** Fork a session at an entry */
	fork(source: Session, entryId: string, options: ForkOptions): Promise<Session>;

	/** List sessions in a workspace */
	list(workspaceId: WorkspaceId): Promise<SessionSummary[]>;

	/** Delete a session */
	delete(sessionId: SessionId): Promise<void>;

	/** Export session to portable format */
	export(sessionId: SessionId, format: ExportFormat): Promise<ExportResult>;

	/** Import session from portable format */
	import(data: unknown, format: ExportFormat, options: ImportOptions): Promise<Session>;
}

/**
 * Session creation options.
 */
export interface CreateSessionOptions {
	workspaceId: WorkspaceId;
	cwd: string;
	initialModel?: string;
	initialThinkingLevel?: string;
	parentSessionId?: SessionId;
	metadata?: Record<string, unknown>;
}

/**
 * Fork options.
 */
export interface ForkOptions {
	label?: string;
	includeHistory?: boolean;
	customInstructions?: string;
}

/**
 * Session summary for listing.
 */
export interface SessionSummary {
	id: SessionId;
	path: string;
	workspaceId: WorkspaceId;
	cwd: string;
	createdAt: number;
	updatedAt: number;
	model?: string;
	thinkingLevel?: string;
	entryCount: number;
	labels?: string[];
}

/**
 * Session interface.
 */
export interface Session {
	readonly id: SessionId;
	readonly workspaceId: WorkspaceId;
	readonly cwd: string;
	readonly createdAt: number;
	readonly updatedAt: number;

	/** Append an entry */
	append(entry: SessionEntry): Promise<void>;

	/** Get entries (with optional filtering) */
	getEntries(options?: GetEntriesOptions): Promise<SessionEntry[]>;

	/** Get session header */
	getHeader(): SessionHeader;

	/** Update session info */
	updateInfo(info: Partial<SessionInfo>): Promise<void>;

	/** Close session */
	close(): Promise<void>;
}

/**
 * Session entry types.
 */
export const SessionEntryType = {
	Message: "message",
	CustomMessage: "custom_message",
	Compaction: "compaction",
	BranchSummary: "branch_summary",
	BashExecution: "bash_execution",
	ThinkingLevelChange: "thinking_level_change",
	ModelChange: "model_change",
	SessionInfo: "session_info",
} as const;

export type SessionEntryType = (typeof SessionEntryType)[keyof typeof SessionEntryType];

/**
 * Session entry.
 */
export interface SessionEntry {
	id: string;
	type: SessionEntryType;
	timestamp: number;
	data: unknown;
	parentId?: string;
	labels?: string[];
}

/**
 * Session header.
 */
export interface SessionHeader {
	version: number;
	id: SessionId;
	cwd: string;
	createdAt: number;
	model?: string;
	thinkingLevel?: string;
}

/**
 * Session info.
 */
export interface SessionInfo {
	name?: string;
	labels?: string[];
	metadata?: Record<string, unknown>;
}

/**
 * Get entries options.
 */
export interface GetEntriesOptions {
	types?: SessionEntryType[];
	since?: number;
	until?: number;
	limit?: number;
	branch?: string;
}

/**
 * Export format.
 */
export const ExportFormat = {
	JSONL: "jsonl",
	JSON: "json",
	HTML: "html",
	Markdown: "markdown",
} as const;

export type ExportFormat = (typeof ExportFormat)[keyof typeof ExportFormat];

/**
 * Export result.
 */
export interface ExportResult {
	content: string | Uint8Array;
	mimeType: string;
	filename: string;
}

/**
 * Import options.
 */
export interface ImportOptions {
	workspaceId: WorkspaceId;
	cwd: string;
	preserveIds?: boolean;
}

/**
 * File system service - sandboxed file system access.
 * All paths resolved relative to workspace root with permission checks.
 */
export interface FileSystemService {
	/** Read file */
	read(path: string, options?: ReadOptions): Promise<string>;

	/** Read file as bytes */
	readBytes(path: string): Promise<Uint8Array>;

	/** Write file */
	write(path: string, content: string | Uint8Array, options?: WriteOptions): Promise<void>;

	/** Append to file */
	append(path: string, content: string): Promise<void>;

	/** Delete file or directory */
	delete(path: string, options?: DeleteOptions): Promise<void>;

	/** Check if exists */
	exists(path: string): Promise<boolean>;

	/** Stat file/directory */
	stat(path: string): Promise<FileStat>;

	/** List directory */
	list(path: string, options?: ListOptions): Promise<FileStat[]>;

	/** Glob pattern matching */
	glob(pattern: string, options?: GlobOptions): Promise<string[]>;

	/** Create directory */
	mkdir(path: string, options?: MkdirOptions): Promise<void>;

	/** Copy file/directory */
	copy(source: string, dest: string, options?: CopyOptions): Promise<void>;

	/** Move file/directory */
	move(source: string, dest: string): Promise<void>;

	/** Watch for changes */
	watch(path: string, listener: WatchListener): WatchHandle;

	/** Resolve path relative to workspace */
	resolve(path: string): string;

	/** Get workspace root */
	getWorkspaceRoot(): string;
}

/**
 * Read options.
 */
export interface ReadOptions {
	encoding?: "utf8" | "binary";
	offset?: number;
	limit?: number;
}

/**
 * Write options.
 */
export interface WriteOptions {
	encoding?: "utf8" | "binary";
	mode?: number;
	createDirs?: boolean;
}

/**
 * Delete options.
 */
export interface DeleteOptions {
	recursive?: boolean;
	force?: boolean;
}

/**
 * File stat.
 */
export interface FileStat {
	path: string;
	name: string;
	isFile: boolean;
	isDirectory: boolean;
	size: number;
	modifiedAt: number;
	createdAt: number;
	permissions?: string;
}

/**
 * List options.
 */
export interface ListOptions {
	recursive?: boolean;
	includeHidden?: boolean;
	filter?: (stat: FileStat) => boolean;
}

/**
 * Glob options.
 */
export interface GlobOptions {
	ignore?: string[];
	absolute?: boolean;
	nodir?: boolean;
}

/**
 * Mkdir options.
 */
export interface MkdirOptions {
	recursive?: boolean;
	mode?: number;
}

/**
 * Copy options.
 */
export interface CopyOptions {
	overwrite?: boolean;
	preserveTimestamps?: boolean;
}

/**
 * Watch listener.
 */
export interface WatchListener {
	onChange(path: string, event: WatchEvent): void;
	onError?(error: Error): void;
}

/**
 * Watch event.
 */
export const WatchEvent = {
	Created: "created",
	Modified: "modified",
	Deleted: "deleted",
	Renamed: "renamed",
} as const;

export type WatchEvent = (typeof WatchEvent)[keyof typeof WatchEvent];

/**
 * Watch handle.
 */
export interface WatchHandle {
	close(): Promise<void>;
}

/**
 * Process service - spawn, exec, shell, PTY management.
 */
export interface ProcessService {
	/** Spawn a process */
	spawn(command: string, args: string[], options: SpawnOptions): ProcessHandle;

	/** Execute command and wait for completion */
	exec(command: string, args: string[], options: ExecOptions): Promise<ExecResult>;

	/** Execute in shell */
	shell(command: string, options: ShellOptions): Promise<ExecResult>;

	/** Spawn PTY (for interactive processes) */
	spawnPty(command: string, args: string[], options: PtyOptions): PtyHandle;

	/** Kill a process */
	kill(pid: number, signal?: string): Promise<void>;

	/** Get process info */
	getProcess(pid: number): ProcessInfo | undefined;
}

/**
 * Spawn options.
 */
export interface SpawnOptions {
	cwd?: string;
	env?: Record<string, string>;
	stdio?: ("pipe" | "inherit" | "ignore")[];
	detached?: boolean;
	timeout?: number;
	signal?: AbortSignal;
}

/**
 * Process handle.
 */
export interface ProcessHandle {
	readonly pid: number;
	readonly stdin: WritableStream | null;
	readonly stdout: ReadableStream | null;
	readonly stderr: ReadableStream | null;
	readonly exited: Promise<number>;
	kill(signal?: string): Promise<void>;
}

/**
 * Exec options.
 */
export interface ExecOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeout?: number;
	maxBuffer?: number;
	signal?: AbortSignal;
	shell?: boolean;
}

/**
 * Exec result.
 */
export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
	killed: boolean;
}

/**
 * Shell options.
 */
export interface ShellOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeout?: number;
	shell?: string;
}

/**
 * PTY options.
 */
export interface PtyOptions {
	cwd?: string;
	env?: Record<string, string>;
	cols?: number;
	rows?: number;
	signal?: AbortSignal;
}

/**
 * PTY handle.
 */
export interface PtyHandle {
	readonly pid: number;
	readonly cols: number;
	readonly rows: number;
	resize(cols: number, rows: number): void;
	write(data: string): void;
	onData(listener: (data: string) => void): () => void;
	onExit(listener: (exitCode: number) => void): () => void;
	kill(signal?: string): Promise<void>;
}

/**
 * Process info.
 */
export interface ProcessInfo {
	pid: number;
	ppid: number;
	command: string;
	args: string[];
	cwd: string;
	startTime: number;
	memoryUsage?: number;
	cpuUsage?: number;
}

/**
 * Network service - HTTP client, WebSocket, proxy, cert management.
 */
export interface NetworkService {
	/** HTTP request */
	request(options: RequestOptions): Promise<Response>;

	/** Fetch (convenience) */
	fetch(url: string, options?: FetchOptions): Promise<Response>;

	/** Create WebSocket connection */
	websocket(url: string, options: WebSocketOptions): WebSocketConnection;

	/** Get proxy configuration */
	getProxy(): ProxyConfig | undefined;

	/** Set proxy configuration */
	setProxy(config: ProxyConfig): void;

	/** Test connectivity */
	ping(url: string, timeout?: number): Promise<boolean>;
}

/**
 * Request options.
 */
export interface RequestOptions {
	method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
	url: string;
	headers?: Record<string, string>;
	body?: unknown;
	timeout?: number;
	signal?: AbortSignal;
	proxy?: ProxyConfig;
	cert?: CertConfig;
}

/**
 * Fetch options.
 */
export interface FetchOptions {
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
	headers?: Record<string, string>;
	body?: unknown;
	timeout?: number;
	signal?: AbortSignal;
}

/**
 * Response wrapper.
 */
export interface Response {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	ok: boolean;
	json<T>(): Promise<T>;
	text(): Promise<string>;
	bytes(): Promise<Uint8Array>;
	blob(): Promise<Blob>;
}

/**
 * WebSocket options.
 */
export interface WebSocketOptions {
	protocols?: string[];
	headers?: Record<string, string>;
	timeout?: number;
	signal?: AbortSignal;
}

/**
 * WebSocket connection.
 */
export interface WebSocketConnection {
	readonly readyState: number;
	send(data: string | Uint8Array): void;
	close(code?: number, reason?: string): void;
	onMessage(listener: (data: string | Uint8Array) => void): () => void;
	onClose(listener: (code: number, reason: string) => void): () => void;
	onError(listener: (error: Error) => void): () => void;
}

/**
 * Proxy configuration.
 */
export interface ProxyConfig {
	http?: string;
	https?: string;
	noProxy?: string[];
}

/**
 * Certificate configuration.
 */
export interface CertConfig {
	ca?: string;
	cert?: string;
	key?: string;
	rejectUnauthorized?: boolean;
}

/**
 * Auth service - credential storage, OAuth flows, API key management.
 */
export interface AuthService {
	/** Get credential for a provider */
	getCredential(providerId: string): Promise<Credential | undefined>;

	/** Set credential for a provider */
	setCredential(providerId: string, credential: Credential): Promise<void>;

	/** Delete credential */
	deleteCredential(providerId: string): Promise<void>;

	/** List all credentials */
	listCredentials(): Promise<CredentialSummary[]>;

	/** Start OAuth flow */
	startOAuth(providerId: string, options: OAuthStartOptions): Promise<OAuthResult>;

	/** Complete OAuth flow */
	completeOAuth(providerId: string, code: string, state: string): Promise<Credential>;

	/** Refresh OAuth token */
	refreshToken(providerId: string): Promise<Credential>;

	/** Get API key from environment */
	getApiKey(envVar: string): string | undefined;

	/** Set runtime API key override */
	setRuntimeApiKey(providerId: string, apiKey: string): Promise<void>;
}

/**
 * Credential.
 */
export interface Credential {
	type: "api_key" | "oauth" | "none";
	providerId: string;
	apiKey?: string;
	accessToken?: string;
	refreshToken?: string;
	expiresAt?: number;
	scopes?: string[];
	metadata?: Record<string, unknown>;
}

/**
 * Credential summary.
 */
export interface CredentialSummary {
	providerId: string;
	type: "api_key" | "oauth" | "none";
	hasApiKey: boolean;
	hasValidToken: boolean;
	expiresAt?: number;
}

/**
 * OAuth start options.
 */
export interface OAuthStartOptions {
	redirectUrl: string;
	scopes: string[];
	state?: string;
}

/**
 * OAuth result.
 */
export interface OAuthResult {
	url: string;
	state: string;
	codeVerifier?: string;
}

/**
 * Cache service - key-value with TTL and invalidation.
 */
export interface CacheService {
	/** Get value */
	get<T>(key: string): Promise<T | undefined>;

	/** Set value with TTL */
	set(key: string, value: unknown, ttlMs?: number): Promise<void>;

	/** Delete value */
	delete(key: string): Promise<void>;

	/** Check if exists */
	has(key: string): Promise<boolean>;

	/** Clear all */
	clear(): Promise<void>;

	/** Get or compute */
	getOrCompute<T>(key: string, compute: () => Promise<T>, ttlMs?: number): Promise<T>;

	/** Invalidate by pattern */
	invalidate(pattern: string): Promise<void>;

	/** Get stats */
	stats(): Promise<CacheStats>;
}

/**
 * Cache stats.
 */
export interface CacheStats {
	size: number;
	hits: number;
	misses: number;
	hitRate: number;
}

/**
 * Event bus service - typed event emission, ordered delivery, replay.
 */
export interface EventBusService {
	/** Emit an event */
	emit<T extends PlatformEvent>(event: T): Promise<void>;

	/** Emit and wait for all handlers */
	emitSync<T extends PlatformEvent>(event: T): Promise<void>;

	/** Subscribe to events */
	subscribe<T extends PlatformEvent>(
		eventType: T["type"],
		handler: EventHandler<T>,
		options?: SubscribeOptions,
	): () => void;

	/** Subscribe to all events */
	subscribeAll(handler: EventHandler<PlatformEvent>, options?: SubscribeOptions): () => void;

	/** Get event history (replay) */
	getHistory(eventType?: string, since?: number): Promise<PlatformEvent[]>;

	/** Clear history */
	clearHistory(): Promise<void>;
}

/**
 * Event handler.
 */
export type EventHandler<T extends PlatformEvent> = (event: T) => Promise<void> | void;

/**
 * Permission service - capability permissions, user consent.
 */
export interface PermissionService {
	/** Check if capability has permission */
	check(capabilityId: CapabilityId, permission: PermissionKey): Promise<PermissionResult>;

	/** Request permission from user */
	request(capabilityId: CapabilityId, permission: PermissionRequest): Promise<PermissionGrant>;

	/** Get all grants for a capability */
	getGrants(capabilityId: CapabilityId): PermissionGrant[];

	/** Revoke permission */
	revoke(capabilityId: CapabilityId, permission: PermissionKey): Promise<void>;

	/** Get permission manifest for a capability */
	getManifest(capabilityId: CapabilityId): CapabilityPermissions | undefined;
}

/**
 * Permission request.
 */
export interface PermissionRequest {
	key: PermissionKey;
	reason: string;
	required: boolean;
}

/**
 * Permission grant.
 */
export interface PermissionGrant {
	key: PermissionKey;
	granted: boolean;
	grantedAt: number;
	grantedBy: "user" | "config" | "default";
	expiresAt?: number;
}

/**
 * Permission result.
 */
export interface PermissionResult {
	allowed: boolean;
	reason?: string;
	grant?: PermissionGrant;
}

/**
 * Logging service - structured logging.
 */
export interface LoggingService {
	debug(message: string, meta?: Record<string, unknown>): void;
	info(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	error(message: string, meta?: Record<string, unknown>): void;
	fatal(message: string, meta?: Record<string, unknown>): void;

	/** Create child logger with bound context */
	child(context: Record<string, unknown>): LoggingService;

	/** Set log level */
	setLevel(level: LogLevel): void;

	/** Get current log level */
	getLevel(): LogLevel;
}

/**
 * Log level.
 */
export const LogLevel = {
	Debug: 0,
	Info: 1,
	Warn: 2,
	Error: 3,
	Fatal: 4,
} as const;

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/**
 * Configuration service - unified configuration management.
 * Distinct from SettingsService - this is for capability configuration.
 */
export interface ConfigurationService {
	/** Get configuration for a capability */
	getCapabilityConfig(capabilityId: CapabilityId): CapabilityConfiguration;

	/** Set configuration for a capability */
	setCapabilityConfig(capabilityId: CapabilityId, config: Partial<CapabilityConfiguration>): Promise<void>;

	/** Get feature flags for a capability */
	getFeatureFlags(capabilityId: CapabilityId): CapabilityFeatureFlags;

	/** Set feature flag */
	setFeatureFlag(capabilityId: CapabilityId, flag: string, value: boolean | string | number): Promise<void>;

	/** Register capability configuration schema */
	registerSchema(capabilityId: CapabilityId, schema: ConfigurationSchema): void;

	/** Validate configuration */
	validate(capabilityId: CapabilityId, config: unknown): ValidationResult;
}

/**
 * Configuration schema.
 */
export interface ConfigurationSchema {
	settings?: object; // TSchema
	featureFlags?: Record<string, { type: "boolean" | "string" | "number"; default: unknown }>;
}

/**
 * Telemetry service - metrics, traces, analytics.
 */
export interface TelemetryService {
	/** Record a metric */
	recordMetric(metric: Metric): void;

	/** Start a trace */
	startTrace(name: string, attributes?: Record<string, unknown>): Trace;

	/** Record an event */
	recordEvent(event: TelemetryEvent): void;

	/** Flush buffered telemetry */
	flush(): Promise<void>;

	/** Shutdown */
	shutdown(): Promise<void>;
}

/**
 * Metric.
 */
export interface Metric {
	name: string;
	value: number;
	type: "counter" | "gauge" | "histogram";
	attributes?: Record<string, string>;
	timestamp?: number;
}

/**
 * Trace.
 */
export interface Trace {
	name: string;
	spanId: string;
	traceId: string;
	startTime: number;
	endTime?: number;
	attributes: Record<string, unknown>;
	events: TraceEvent[];
	status: "ok" | "error" | "unset";
	end(attributes?: Record<string, unknown>): void;
	addEvent(name: string, attributes?: Record<string, unknown>): void;
	recordError(error: Error): void;
}

/**
 * Trace event.
 */
export interface TraceEvent {
	name: string;
	timestamp: number;
	attributes: Record<string, unknown>;
}

/**
 * Telemetry event.
 */
export interface TelemetryEvent {
	name: string;
	attributes?: Record<string, unknown>;
	timestamp?: number;
}
