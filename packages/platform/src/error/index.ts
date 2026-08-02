/**
 * Error Contracts
 *
 * Canonical platform errors for the capability platform.
 * All errors are structured, typed, and serializable.
 * NO IMPLEMENTATIONS - error classes and types only.
 */

import type { CapabilityId, CapabilityVersion, EventId } from "../identifier/index.ts";
import type { ValidationResult } from "../runtime/index.ts";

/**
 * Base platform error.
 * All platform errors extend this.
 */
export class PlatformError extends Error {
	readonly code: string;
	readonly status: number;
	readonly metadata: Record<string, unknown>;
	timestamp: number;
	errorId: EventId;

	constructor(
		message: string,
		options: {
			code: string;
			status?: number;
			metadata?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, { cause: options.cause });
		this.name = "PlatformError";
		this.code = options.code;
		this.status = options.status ?? 500;
		this.metadata = options.metadata ?? {};
		this.timestamp = Date.now();
		this.errorId = crypto.randomUUID() as EventId;

		// Maintain proper stack trace
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, PlatformError);
		}
	}

	/** Serialize to JSON */
	toJSON(): PlatformErrorJSON {
		return {
			name: this.name,
			message: this.message,
			code: this.code,
			status: this.status,
			metadata: this.metadata,
			timestamp: this.timestamp,
			errorId: this.errorId,
			stack: this.stack,
			cause: this.cause ? (this.cause as PlatformError).toJSON?.() : undefined,
		};
	}

	/** Create from JSON */
	static fromJSON(json: PlatformErrorJSON): PlatformError {
		const error = new PlatformError(json.message, {
			code: json.code,
			status: json.status,
			metadata: json.metadata,
		});
		error.timestamp = json.timestamp;
		error.errorId = json.errorId;
		if (json.stack) error.stack = json.stack;
		return error;
	}
}

/**
 * Serialized platform error.
 */
export interface PlatformErrorJSON {
	name: string;
	message: string;
	code: string;
	status: number;
	metadata: Record<string, unknown>;
	timestamp: number;
	errorId: EventId;
	stack?: string;
	cause?: PlatformErrorJSON;
}

/**
 * Capability-related errors.
 */
export class CapabilityError extends PlatformError {
	readonly capabilityId: CapabilityId;
	readonly capabilityVersion?: CapabilityVersion;
	readonly phase: CapabilityErrorPhase;

	constructor(
		message: string,
		options: {
			capabilityId: CapabilityId;
			capabilityVersion?: CapabilityVersion;
			phase: CapabilityErrorPhase;
			code?: string;
			metadata?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, {
			code: options.code ?? "CAPABILITY_ERROR",
			metadata: { ...options.metadata, capabilityId: options.capabilityId, phase: options.phase },
			cause: options.cause,
		});
		this.name = "CapabilityError";
		this.capabilityId = options.capabilityId;
		this.capabilityVersion = options.capabilityVersion;
		this.phase = options.phase;
	}
}

/**
 * Capability error phase.
 */
export const CapabilityErrorPhase = {
	Discovery: "discovery",
	Registration: "registration",
	Resolution: "resolution",
	Initialization: "initialization",
	Execution: "execution",
	Shutdown: "shutdown",
} as const;

export type CapabilityErrorPhase = (typeof CapabilityErrorPhase)[keyof typeof CapabilityErrorPhase];

/**
 * Dependency errors.
 */
export class DependencyError extends PlatformError {
	readonly capabilityId: CapabilityId;
	readonly dependencyId: CapabilityId;
	readonly dependencyVersion: string;
	readonly reason: DependencyErrorReason;

	constructor(
		message: string,
		options: {
			capabilityId: CapabilityId;
			dependencyId: CapabilityId;
			dependencyVersion: string;
			reason: DependencyErrorReason;
			metadata?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, {
			code: "DEPENDENCY_ERROR",
			metadata: { ...options.metadata, capabilityId: options.capabilityId, dependencyId: options.dependencyId },
			cause: options.cause,
		});
		this.name = "DependencyError";
		this.capabilityId = options.capabilityId;
		this.dependencyId = options.dependencyId;
		this.dependencyVersion = options.dependencyVersion;
		this.reason = options.reason;
	}
}

/**
 * Dependency error reason.
 */
export const DependencyErrorReason = {
	NotFound: "not_found",
	VersionConflict: "version_conflict",
	CircularDependency: "circular_dependency",
	MissingRequired: "missing_required",
	IncompatiblePeer: "incompatible_peer",
	LoadFailed: "load_failed",
} as const;

export type DependencyErrorReason = (typeof DependencyErrorReason)[keyof typeof DependencyErrorReason];

/**
 * Permission errors.
 */
export class PermissionError extends PlatformError {
	readonly capabilityId: CapabilityId;
	readonly permission: string;
	readonly required: boolean;

	constructor(
		message: string,
		options: {
			capabilityId: CapabilityId;
			permission: string;
			required: boolean;
			metadata?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, {
			code: "PERMISSION_ERROR",
			status: 403,
			metadata: { ...options.metadata, capabilityId: options.capabilityId, permission: options.permission },
			cause: options.cause,
		});
		this.name = "PermissionError";
		this.capabilityId = options.capabilityId;
		this.permission = options.permission;
		this.required = options.required;
	}
}

/**
 * Configuration errors.
 */
export class ConfigurationError extends PlatformError {
	readonly capabilityId?: CapabilityId;
	readonly configPath?: string;
	readonly validationErrors?: ValidationResult;

	constructor(
		message: string,
		options: {
			capabilityId?: CapabilityId;
			configPath?: string;
			validationErrors?: ValidationResult;
			metadata?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, {
			code: "CONFIGURATION_ERROR",
			metadata: { ...options.metadata, capabilityId: options.capabilityId, configPath: options.configPath },
			cause: options.cause,
		});
		this.name = "ConfigurationError";
		this.capabilityId = options.capabilityId;
		this.configPath = options.configPath;
		this.validationErrors = options.validationErrors;
	}
}

/**
 * Validation errors.
 */
export class ValidationError extends PlatformError {
	readonly validationErrors: ValidationResult;

	constructor(
		message: string,
		options: {
			validationErrors: ValidationResult;
			metadata?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, {
			code: "VALIDATION_ERROR",
			status: 400,
			metadata: options.metadata,
			cause: options.cause,
		});
		this.name = "ValidationError";
		this.validationErrors = options.validationErrors;
	}
}

/**
 * Lifecycle errors.
 */
export class LifecycleError extends PlatformError {
	readonly capabilityId: CapabilityId;
	readonly phase: CapabilityErrorPhase;
	readonly operation: LifecycleOperation;

	constructor(
		message: string,
		options: {
			capabilityId: CapabilityId;
			phase: CapabilityErrorPhase;
			operation: LifecycleOperation;
			metadata?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, {
			code: "LIFECYCLE_ERROR",
			metadata: {
				...options.metadata,
				capabilityId: options.capabilityId,
				phase: options.phase,
				operation: options.operation,
			},
			cause: options.cause,
		});
		this.name = "LifecycleError";
		this.capabilityId = options.capabilityId;
		this.phase = options.phase;
		this.operation = options.operation;
	}
}

/**
 * Lifecycle operation.
 */
export const LifecycleOperation = {
	Load: "load",
	Validate: "validate",
	Initialize: "initialize",
	Start: "start",
	Stop: "stop",
	Unload: "unload",
	Restart: "restart",
} as const;

export type LifecycleOperation = (typeof LifecycleOperation)[keyof typeof LifecycleOperation];

/**
 * Registry errors.
 */
export class RegistryError extends PlatformError {
	readonly capabilityId?: CapabilityId;
	readonly operation: RegistryOperation;

	constructor(
		message: string,
		options: {
			capabilityId?: CapabilityId;
			operation: RegistryOperation;
			metadata?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, {
			code: "REGISTRY_ERROR",
			metadata: { ...options.metadata, capabilityId: options.capabilityId, operation: options.operation },
			cause: options.cause,
		});
		this.name = "RegistryError";
		this.capabilityId = options.capabilityId;
		this.operation = options.operation;
	}
}

/**
 * Registry operation.
 */
export const RegistryOperation = {
	Register: "register",
	Unregister: "unregister",
	Get: "get",
	Find: "find",
	Resolve: "resolve",
	Subscribe: "subscribe",
} as const;

export type RegistryOperation = (typeof RegistryOperation)[keyof typeof RegistryOperation];

/**
 * Service errors.
 */
export class ServiceError extends PlatformError {
	readonly serviceId: string;
	readonly operation: string;

	constructor(
		message: string,
		options: {
			serviceId: string;
			operation: string;
			metadata?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, {
			code: "SERVICE_ERROR",
			metadata: { ...options.metadata, serviceId: options.serviceId, operation: options.operation },
			cause: options.cause,
		});
		this.name = "ServiceError";
		this.serviceId = options.serviceId;
		this.operation = options.operation;
	}
}

/**
 * Event errors.
 */
export class EventError extends PlatformError {
	readonly eventId?: EventId;
	readonly eventType?: string;
	readonly operation: EventErrorOperation;

	constructor(
		message: string,
		options: {
			eventId?: EventId;
			eventType?: string;
			operation: EventErrorOperation;
			metadata?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, {
			code: "EVENT_ERROR",
			metadata: {
				...options.metadata,
				eventId: options.eventId,
				eventType: options.eventType,
				operation: options.operation,
			},
			cause: options.cause,
		});
		this.name = "EventError";
		this.eventId = options.eventId;
		this.eventType = options.eventType;
		this.operation = options.operation;
	}
}

/**
 * Event error operation.
 */
export const EventErrorOperation = {
	Emit: "emit",
	Subscribe: "subscribe",
	Replay: "replay",
	History: "history",
} as const;

export type EventErrorOperation = (typeof EventErrorOperation)[keyof typeof EventErrorOperation];

/**
 * Runtime errors.
 */
export class RuntimeError extends PlatformError {
	readonly runtimeId: string;
	readonly phase: RuntimePhase;

	constructor(
		message: string,
		options: {
			runtimeId: string;
			phase: RuntimePhase;
			metadata?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, {
			code: "RUNTIME_ERROR",
			metadata: { ...options.metadata, runtimeId: options.runtimeId, phase: options.phase },
			cause: options.cause,
		});
		this.name = "RuntimeError";
		this.runtimeId = options.runtimeId;
		this.phase = options.phase;
	}
}

/**
 * Runtime phase.
 */
export const RuntimePhase = {
	Starting: "starting",
	Running: "running",
	Stopping: "stopping",
	Shutdown: "shutdown",
} as const;

export type RuntimePhase = (typeof RuntimePhase)[keyof typeof RuntimePhase];

/**
 * Host errors.
 */
export class HostError extends PlatformError {
	readonly hostId: string;
	readonly hostType: string;

	constructor(
		message: string,
		options: {
			hostId: string;
			hostType: string;
			metadata?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, {
			code: "HOST_ERROR",
			metadata: { ...options.metadata, hostId: options.hostId, hostType: options.hostType },
			cause: options.cause,
		});
		this.name = "HostError";
		this.hostId = options.hostId;
		this.hostType = options.hostType;
	}
}

/**
 * Serialization errors.
 */
export class SerializationError extends PlatformError {
	readonly targetType: string;

	constructor(
		message: string,
		options: {
			targetType: string;
			metadata?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, {
			code: "SERIALIZATION_ERROR",
			metadata: { ...options.metadata, targetType: options.targetType },
			cause: options.cause,
		});
		this.name = "SerializationError";
		this.targetType = options.targetType;
	}
}

/**
 * Not found errors.
 */
export class NotFoundError extends PlatformError {
	readonly resourceType: string;
	readonly resourceId: string;

	constructor(
		message: string,
		options: {
			resourceType: string;
			resourceId: string;
			metadata?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, {
			code: "NOT_FOUND",
			status: 404,
			metadata: { ...options.metadata, resourceType: options.resourceType, resourceId: options.resourceId },
			cause: options.cause,
		});
		this.name = "NotFoundError";
		this.resourceType = options.resourceType;
		this.resourceId = options.resourceId;
	}
}

/**
 * Conflict errors.
 */
export class ConflictError extends PlatformError {
	readonly resourceType: string;
	readonly resourceId: string;
	readonly conflictingId: string;

	constructor(
		message: string,
		options: {
			resourceType: string;
			resourceId: string;
			conflictingId: string;
			metadata?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, {
			code: "CONFLICT",
			status: 409,
			metadata: {
				...options.metadata,
				resourceType: options.resourceType,
				resourceId: options.resourceId,
				conflictingId: options.conflictingId,
			},
			cause: options.cause,
		});
		this.name = "ConflictError";
		this.resourceType = options.resourceType;
		this.resourceId = options.resourceId;
		this.conflictingId = options.conflictingId;
	}
}

/**
 * Timeout errors.
 */
export class TimeoutError extends PlatformError {
	readonly operation: string;
	readonly timeoutMs: number;

	constructor(
		message: string,
		options: {
			operation: string;
			timeoutMs: number;
			metadata?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, {
			code: "TIMEOUT",
			status: 408,
			metadata: { ...options.metadata, operation: options.operation, timeoutMs: options.timeoutMs },
			cause: options.cause,
		});
		this.name = "TimeoutError";
		this.operation = options.operation;
		this.timeoutMs = options.timeoutMs;
	}
}

/**
 * Cancellation errors.
 */
export class CancellationError extends PlatformError {
	readonly operation: string;

	constructor(
		message: string,
		options: {
			operation: string;
			metadata?: Record<string, unknown>;
			cause?: Error;
		},
	) {
		super(message, {
			code: "CANCELLED",
			status: 499,
			metadata: { ...options.metadata, operation: options.operation },
			cause: options.cause,
		});
		this.name = "CancellationError";
		this.operation = options.operation;
	}
}

/**
 * Error codes enum for programmatic handling.
 */
export const ErrorCode = {
	// Platform
	PlatformError: "PLATFORM_ERROR",

	// Capability
	CapabilityError: "CAPABILITY_ERROR",
	DependencyError: "DEPENDENCY_ERROR",

	// Permission
	PermissionError: "PERMISSION_ERROR",

	// Configuration
	ConfigurationError: "CONFIGURATION_ERROR",
	ValidationError: "VALIDATION_ERROR",

	// Lifecycle
	LifecycleError: "LIFECYCLE_ERROR",

	// Registry
	RegistryError: "REGISTRY_ERROR",

	// Service
	ServiceError: "SERVICE_ERROR",

	// Event
	EventError: "EVENT_ERROR",

	// Runtime
	RuntimeError: "RUNTIME_ERROR",

	// Host
	HostError: "HOST_ERROR",

	// Serialization
	SerializationError: "SERIALIZATION_ERROR",

	// Generic
	NotFound: "NOT_FOUND",
	Conflict: "CONFLICT",
	Timeout: "TIMEOUT",
	Cancellation: "CANCELLED",
} as const;

/**
 * Type guard for PlatformError.
 */
export function isPlatformError(error: unknown): error is PlatformError {
	return error instanceof PlatformError;
}

/**
 * Type guard for specific error types.
 */
export function isCapabilityError(error: unknown): error is CapabilityError {
	return error instanceof CapabilityError;
}

export function isDependencyError(error: unknown): error is DependencyError {
	return error instanceof DependencyError;
}

export function isPermissionError(error: unknown): error is PermissionError {
	return error instanceof PermissionError;
}

export function isConfigurationError(error: unknown): error is ConfigurationError {
	return error instanceof ConfigurationError;
}

export function isValidationError(error: unknown): error is ValidationError {
	return error instanceof ValidationError;
}

export function isLifecycleError(error: unknown): error is LifecycleError {
	return error instanceof LifecycleError;
}

export function isRegistryError(error: unknown): error is RegistryError {
	return error instanceof RegistryError;
}

export function isServiceError(error: unknown): error is ServiceError {
	return error instanceof ServiceError;
}

export function isEventError(error: unknown): error is EventError {
	return error instanceof EventError;
}

export function isRuntimeError(error: unknown): error is RuntimeError {
	return error instanceof RuntimeError;
}

export function isHostError(error: unknown): error is HostError {
	return error instanceof HostError;
}

export function isNotFoundError(error: unknown): error is NotFoundError {
	return error instanceof NotFoundError;
}

export function isConflictError(error: unknown): error is ConflictError {
	return error instanceof ConflictError;
}

export function isTimeoutError(error: unknown): error is TimeoutError {
	return error instanceof TimeoutError;
}

export function isCancellationError(error: unknown): error is CancellationError {
	return error instanceof CancellationError;
}

/**
 * Error factory for creating errors from unknown values.
 */
export function toPlatformError(error: unknown, defaultCode = ErrorCode.PlatformError): PlatformError {
	if (error instanceof PlatformError) return error;
	if (error instanceof Error) {
		return new PlatformError(error.message, { code: defaultCode, cause: error });
	}
	return new PlatformError(String(error), { code: defaultCode });
}
