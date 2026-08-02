/**
 * Walking-skeleton runtime (kernel).
 *
 * Orchestrates startup and shutdown only. Owns the component graph
 * (discovery, registry, resolver, loader, lifecycle manager, service provider,
 * event bus) and drives the pipeline: discover → register → resolve → load →
 * init → ready, then reverse-order shutdown. Contains no application logic.
 */

import type { CapabilityContext, CapabilityManifest } from "../capability/index.ts";
import type { CapabilityId, RuntimeId } from "../identifier/index.ts";
import { capabilityVersion, runtimeId } from "../identifier/index.ts";
import type {
	CapabilityDiscovery,
	CapabilityResolver,
	Runtime,
	RuntimeHealth,
	ServiceProvider,
} from "../runtime/index.ts";
import type { EventBusService } from "../service/index.ts";
import { type BuiltinCapability, BuiltinCapabilityDiscovery } from "./discovery.ts";
import { KernelEventBus } from "./event-bus.ts";
import { KernelLifecycleManager } from "./lifecycle.ts";
import { BuiltinCapabilityLoader } from "./loader.ts";
import { KernelCapabilityRegistry, type KernelRegistry } from "./registry.ts";
import { SimpleCapabilityResolver } from "./resolver.ts";
import { KernelServiceProvider, type KernelServiceProviderOptions } from "./service-provider.ts";

export interface KernelRuntimeOptions {
	/** Builtin capabilities supplied by the host (manifest + factory). */
	builtins: readonly BuiltinCapability[];
	/** Service provider overrides (e.g. a custom FileSystemService). */
	services?: KernelServiceProviderOptions;
	/** Optional runtime id. Defaults to a fresh random id. */
	runtimeId?: RuntimeId;
}

export class KernelRuntime implements Runtime {
	readonly id: RuntimeId;
	readonly capabilities: KernelRegistry;
	readonly events: EventBusService;
	readonly services: ServiceProvider;

	private readonly discovery: CapabilityDiscovery;
	private readonly resolver: CapabilityResolver;
	private readonly lifecycle: KernelLifecycleManager;
	private state: "created" | "initialized" | "started" | "shutdown" = "created";
	private readonly startedAt: number;

	constructor(options: KernelRuntimeOptions) {
		this.id = options.runtimeId ?? runtimeId();
		this.startedAt = Date.now();
		this.events = new KernelEventBus();
		this.services = new KernelServiceProvider({
			...options.services,
			events: options.services?.events ?? this.events,
		});
		this.capabilities = new KernelCapabilityRegistry(this.events);
		this.discovery = new BuiltinCapabilityDiscovery(options.builtins);
		this.resolver = new SimpleCapabilityResolver((id) => this.capabilities.get(id)?.manifest);
		this.lifecycle = new KernelLifecycleManager({
			registry: this.capabilities,
			resolver: this.resolver,
			events: this.events,
			createContext: (id) => this.createContext(id),
		});
	}

	async initialize(): Promise<void> {
		const discovered = await this.discovery.discover();
		for (const item of discovered) {
			const loader = new BuiltinCapabilityLoader(item.loadSpec);
			await this.capabilities.register(item.manifest, loader);
		}
		await this.lifecycle.initializeAll();
		this.state = "initialized";
	}

	async start(): Promise<void> {
		this.state = "started";
	}

	async shutdown(): Promise<void> {
		if (this.state === "shutdown") return;
		await this.lifecycle.shutdownAll();
		this.state = "shutdown";
	}

	async health(): Promise<RuntimeHealth> {
		const infos = this.capabilities.getAll();
		const ready = infos.filter((info) => info.state === "ready").length;
		const error = infos.filter((info) => info.state === "error").length;
		return {
			status: error > 0 ? "degraded" : this.state === "started" ? "healthy" : "unhealthy",
			uptime: Date.now() - this.startedAt,
			capabilities: { total: infos.length, ready, error },
			services: {
				fs: "healthy",
				events: "healthy",
			},
		};
	}

	private createContext(id: CapabilityId): CapabilityContext {
		const info = this.capabilities.get(id);
		const manifest: CapabilityManifest | undefined = info?.manifest;
		return {
			settings: this.services.settings,
			session: this.services.session,
			fs: this.services.fs,
			process: this.services.process,
			network: this.services.network,
			auth: this.services.auth,
			cache: this.services.cache,
			events: this.events,
			permissions: this.services.permissions,
			logging: this.services.logging,
			configuration: this.services.configuration,
			telemetry: this.services.telemetry,
			capabilities: this.capabilities,
			capabilityId: id,
			capabilityVersion: manifest?.version ?? capabilityVersion("0.0.0"),
			sourceInfo: { type: "builtin", path: id },
		};
	}
}

/** Create an uninitialized runtime. Call `initialize()` then `start()`. */
export function createRuntime(options: KernelRuntimeOptions): KernelRuntime {
	return new KernelRuntime(options);
}
