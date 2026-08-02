/**
 * Walking-skeleton ServiceProvider.
 *
 * Owns service instances. Only FileSystemService is implemented for the pilot;
 * all other services are stubs that throw "not implemented" when used. This
 * matches the Step 1.3 constraint: expose only the services the pilot requires.
 */

import { PlatformError } from "../error/index.ts";
import type { ServiceProvider } from "../runtime/index.ts";
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
import { NodeFileSystemService } from "./fs-service.ts";

/** A stub service whose every method throws "not implemented". */
function notImplementedService(name: string): object {
	return new Proxy(
		{},
		{
			get(_target, prop, _receiver) {
				if (prop === "then") return undefined; // never treat the stub as a thenable
				return () => {
					throw new PlatformError(`Service '${name}' is not implemented in the walking skeleton`, {
						code: "NOT_IMPLEMENTED",
						metadata: { service: name },
					});
				};
			},
		},
	);
}

export interface KernelServiceProviderOptions {
	/** FileSystemService implementation. Defaults to a node:fs wrapper over the given root. */
	fs?: FileSystemService;
	/** Event bus implementation (shared with the runtime). Defaults to a not-implemented stub. */
	events?: EventBusService;
	/** Workspace root for the default FileSystemService. Defaults to process.cwd(). */
	workspaceRoot?: string;
}

export class KernelServiceProvider implements ServiceProvider {
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

	constructor(options: KernelServiceProviderOptions = {}) {
		this.fs = options.fs ?? new NodeFileSystemService(options.workspaceRoot ?? process.cwd());
		this.events = options.events ?? (notImplementedService("events") as EventBusService);
		this.settings = notImplementedService("settings") as SettingsService;
		this.session = notImplementedService("session") as SessionService;
		this.process = notImplementedService("process") as ProcessService;
		this.network = notImplementedService("network") as NetworkService;
		this.auth = notImplementedService("auth") as AuthService;
		this.cache = notImplementedService("cache") as CacheService;
		this.permissions = notImplementedService("permissions") as PermissionService;
		this.logging = notImplementedService("logging") as LoggingService;
		this.configuration = notImplementedService("configuration") as ConfigurationService;
		this.telemetry = notImplementedService("telemetry") as TelemetryService;
	}

	get<T extends keyof ServiceProvider>(id: T): ServiceProvider[T];
	get(id: string): unknown;
	get(id: string): unknown {
		if (id in this) {
			return (this as unknown as Record<string, unknown>)[id];
		}
		throw new PlatformError(`Unknown service: ${id}`, { code: "SERVICE_ERROR" });
	}
}
