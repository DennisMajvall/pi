/**
 * Walking-skeleton lifecycle manager.
 *
 * Controls capability state transitions (registered → resolved → initialized →
 * ready → unloaded, plus error) with dependency-aware initialization and
 * reverse-order shutdown. No restart, reload, suspend, resume, health
 * monitoring, or retries.
 *
 * Kernel extension beyond the Step 1.2 contract: `initializeAll()` and
 * `shutdownAll()` batch drivers used by the Runtime.
 */

import type {
	CapabilityContext,
	CapabilityExports,
	CapabilityLifecycle,
	CapabilityState,
} from "../capability/index.ts";
import { CapabilityState as State } from "../capability/index.ts";
import { NotFoundError, PlatformError } from "../error/index.ts";
import type { CapabilityId } from "../identifier/index.ts";
import {
	type CapabilityResolver,
	type LifecycleListener,
	type LifecycleManager,
	LifecyclePhase,
} from "../runtime/index.ts";
import type { EventBusService } from "../service/index.ts";
import { errorEvent, initializedEvent, readyEvent, shutdownEvent } from "./events.ts";
import type { KernelRegistry } from "./registry.ts";

export interface KernelLifecycleManagerOptions {
	registry: KernelRegistry;
	resolver: CapabilityResolver;
	events: EventBusService;
	/** Build the CapabilityContext for a capability id. */
	createContext: (id: CapabilityId) => CapabilityContext;
}

export class KernelLifecycleManager implements LifecycleManager {
	private readonly registry: KernelRegistry;
	private readonly resolver: CapabilityResolver;
	private readonly events: EventBusService;
	private readonly createContext: (id: CapabilityId) => CapabilityContext;
	private readonly listeners: LifecycleListener[] = [];

	constructor(options: KernelLifecycleManagerOptions) {
		this.registry = options.registry;
		this.resolver = options.resolver;
		this.events = options.events;
		this.createContext = options.createContext;
	}

	async initialize(id: CapabilityId): Promise<CapabilityExports> {
		const graph = await this.resolver.resolve([id]);
		for (const orderedId of graph.initializationOrder) {
			const info = this.registry.get(orderedId);
			if (!info || info.state === State.Ready || info.state === State.Initialized) continue;
			await this.initOne(orderedId);
		}
		const exports = this.registry.getExports(id);
		if (!exports) {
			throw new NotFoundError(`Capability '${id}' did not produce exports (init failed?)`, {
				resourceType: "capability",
				resourceId: id,
			});
		}
		return exports as CapabilityExports;
	}

	async shutdown(id: CapabilityId): Promise<void> {
		const graph = await this.resolver.resolve([id]);
		for (const orderedId of [...graph.initializationOrder].reverse()) {
			const info = this.registry.get(orderedId);
			if (!info || info.state !== State.Ready) continue;
			await this.shutdownOne(orderedId);
		}
	}

	async restart(_id: CapabilityId): Promise<CapabilityExports> {
		throw new PlatformError("LifecycleManager.restart is not implemented in the walking skeleton", {
			code: "NOT_IMPLEMENTED",
		});
	}

	getState(id: CapabilityId): CapabilityState {
		return this.registry.get(id)?.state ?? State.Discovered;
	}

	subscribe(listener: LifecycleListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index !== -1) this.listeners.splice(index, 1);
		};
	}

	// =========================================================================
	// Kernel extension: batch drivers used by Runtime.initialize()/shutdown()
	// =========================================================================

	async initializeAll(): Promise<void> {
		const ids = this.registry.getAll().map((info) => info.manifest.id);
		const graph = await this.resolver.resolve(ids);
		for (const orderedId of graph.initializationOrder) {
			const info = this.registry.get(orderedId);
			if (!info || info.state === State.Ready || info.state === State.Initialized) continue;
			await this.initOne(orderedId);
		}
	}

	async shutdownAll(): Promise<void> {
		const ids = this.registry.getAll().map((info) => info.manifest.id);
		const graph = await this.resolver.resolve(ids);
		for (const orderedId of [...graph.initializationOrder].reverse()) {
			const info = this.registry.get(orderedId);
			if (!info || info.state !== State.Ready) continue;
			await this.shutdownOne(orderedId);
		}
	}

	// =========================================================================

	private async initOne(id: CapabilityId): Promise<void> {
		const loader = this.registry.getLoader(id);
		if (!loader) {
			this.fail(
				id,
				new NotFoundError(`No loader registered for capability '${id}'`, {
					resourceType: "capability",
					resourceId: id,
				}),
			);
			return;
		}

		this.transition(id, State.Resolved);
		const context = this.createContext(id);

		let lifecycle: CapabilityLifecycle;
		try {
			lifecycle = await loader.load(context);
		} catch (error) {
			this.fail(id, toError(error));
			return;
		}

		this.transition(id, State.Initialized);
		await this.events.emit(initializedEvent(id));

		let exports: CapabilityExports;
		try {
			exports = await lifecycle.init(context);
		} catch (error) {
			this.fail(id, toError(error));
			return;
		}

		this.registry.setExports(id, exports, context, lifecycle);
		this.transition(id, State.Ready);
		await this.events.emit(readyEvent(id));
	}

	private async shutdownOne(id: CapabilityId): Promise<void> {
		const lifecycle = this.registry.getLifecycle(id);
		const context = this.registry.getContext(id);
		if (lifecycle?.shutdown && context) {
			try {
				await lifecycle.shutdown(context);
			} catch (error) {
				// Shutdown failures are contained; state still moves to unloaded.
				this.registry.reportError(id, toError(error));
			}
		}
		this.registry.clearExports(id);
		this.transition(id, State.Unloaded);
		await this.events.emit(shutdownEvent(id));
	}

	private transition(id: CapabilityId, to: CapabilityState): void {
		const previous = this.registry.get(id)?.state;
		this.registry.setState(id, to);
		if (previous === undefined) return;
		for (const listener of this.listeners) {
			listener.onStateChange(id, previous, to);
		}
	}

	private fail(id: CapabilityId, error: Error): void {
		const previous = this.registry.get(id)?.state;
		this.registry.setState(id, State.Error, error.message);
		this.registry.reportError(id, error);
		if (previous !== undefined) {
			for (const listener of this.listeners) {
				listener.onError(id, error, LifecyclePhase.Initializing);
			}
		}
		void this.events.emit(errorEvent(id, "initialization", error));
	}
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
