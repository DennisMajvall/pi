/**
 * Walking-skeleton capability registry.
 *
 * Knows what exists: manifests, loaders, lifecycle state, exports, and
 * per-capability contexts. Owns no lifecycle logic; the Lifecycle Manager
 * drives transitions through the internal state API. Emits registration
 * events on the injected event bus.
 *
 * Kernel extension beyond the Step 1.2 contract: `getContext(id)` returns the
 * stored CapabilityContext so consumers can build execution contexts.
 */

import { Value } from "typebox/value";
import type {
	CapabilityCategory,
	CapabilityContext,
	CapabilityExports,
	CapabilityLifecycle,
	CapabilityManifest,
	CapabilityState,
	RuntimeCapabilityInfo,
} from "../capability/index.ts";
import { CapabilityState as State } from "../capability/index.ts";
import { ConflictError, NotFoundError, PlatformError } from "../error/index.ts";
import type { CapabilityId } from "../identifier/index.ts";
import type {
	CapabilityLoader,
	CapabilityQuery,
	CapabilityRegistration,
	CapabilityRegistry,
	RegistryListener,
} from "../runtime/index.ts";
import { CapabilityManifestSchema } from "../schema/index.ts";
import type { EventBusService } from "../service/index.ts";
import { registeredEvent, unregisteredEvent } from "./events.ts";

/** Internal registry entry (richer than the public RuntimeCapabilityInfo). */
interface RegistryEntry {
	manifest: CapabilityManifest;
	loader: CapabilityLoader;
	state: CapabilityState;
	exports: CapabilityExports | undefined;
	context: CapabilityContext | undefined;
	lifecycle: CapabilityLifecycle | undefined;
	error: string | undefined;
	loadedAt: number | undefined;
}

export interface KernelRegistry extends CapabilityRegistry {
	/** Kernel extension: the stored CapabilityContext for a capability. */
	getContext(id: CapabilityId): CapabilityContext | undefined;

	// Internal state API, used by the Lifecycle Manager only.
	getManifest(id: CapabilityId): CapabilityManifest | undefined;
	getLoader(id: CapabilityId): CapabilityLoader | undefined;
	getLifecycle(id: CapabilityId): CapabilityLifecycle | undefined;
	setState(id: CapabilityId, state: CapabilityState, error?: string): void;
	setExports(
		id: CapabilityId,
		exports: CapabilityExports,
		context: CapabilityContext,
		lifecycle: CapabilityLifecycle,
	): void;
	clearExports(id: CapabilityId): void;
	reportError(id: CapabilityId, error: Error): void;
}

export class KernelCapabilityRegistry implements KernelRegistry {
	private readonly entries = new Map<CapabilityId, RegistryEntry>();
	private readonly listeners: RegistryListener[] = [];
	private readonly events: EventBusService;

	constructor(events: EventBusService) {
		this.events = events;
	}

	async register(manifest: CapabilityManifest, loader: CapabilityLoader): Promise<CapabilityRegistration> {
		// Full schema validation at registration time: manifests that do not
		// conform to CapabilityManifestSchema are rejected with the TypeBox
		// error details instead of being registered.
		try {
			Value.Parse(CapabilityManifestSchema, manifest);
		} catch (error) {
			throw new PlatformError("Capability manifest failed schema validation", {
				code: "VALIDATION_ERROR",
				metadata: {
					manifestId: manifest.id,
					details: error instanceof Error ? error.message : String(error),
				},
			});
		}
		if (this.entries.has(manifest.id)) {
			throw new ConflictError(`Capability already registered: ${manifest.id}`, {
				resourceType: "capability",
				resourceId: manifest.id,
				conflictingId: manifest.id,
			});
		}
		const entry: RegistryEntry = {
			manifest,
			loader,
			state: State.Registered,
			exports: undefined,
			context: undefined,
			lifecycle: undefined,
			error: undefined,
			loadedAt: undefined,
		};
		this.entries.set(manifest.id, entry);
		const info = this.toInfo(entry);
		for (const listener of this.listeners) {
			listener.onRegistered(info);
		}
		await this.events.emit(registeredEvent(manifest));
		return { id: manifest.id, version: manifest.version, state: State.Registered };
	}

	async unregister(id: CapabilityId): Promise<void> {
		if (!this.entries.has(id)) {
			throw new NotFoundError(`Capability not registered: ${id}`, {
				resourceType: "capability",
				resourceId: id,
			});
		}
		this.entries.delete(id);
		for (const listener of this.listeners) {
			listener.onUnregistered(id);
		}
		await this.events.emit(unregisteredEvent(id));
	}

	get(id: CapabilityId): RuntimeCapabilityInfo | undefined {
		const entry = this.entries.get(id);
		return entry ? this.toInfo(entry) : undefined;
	}

	getAll(): RuntimeCapabilityInfo[] {
		return [...this.entries.values()].map((entry) => this.toInfo(entry));
	}

	getByCategory(category: CapabilityCategory): RuntimeCapabilityInfo[] {
		return this.getAll().filter((info) => info.manifest.category === category);
	}

	getExports<T = unknown>(id: CapabilityId): T | undefined {
		return this.entries.get(id)?.exports as T | undefined;
	}

	getContext(id: CapabilityId): CapabilityContext | undefined {
		return this.entries.get(id)?.context;
	}

	find(query: CapabilityQuery): RuntimeCapabilityInfo[] {
		return this.getAll().filter((info) => {
			if (query.category !== undefined && info.manifest.category !== query.category) return false;
			if (query.state !== undefined && info.state !== query.state) return false;
			if (query.provides !== undefined && !(query.provides in info.manifest.provides)) return false;
			if (query.requires !== undefined) {
				const deps = info.manifest.requires?.capabilities ?? [];
				if (!deps.some((dep) => dep.id === query.requires)) return false;
			}
			if (query.tags !== undefined && !query.tags.every((tag) => info.manifest.metadata.tags.includes(tag))) {
				return false;
			}
			return true;
		});
	}

	subscribe(listener: RegistryListener): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index !== -1) this.listeners.splice(index, 1);
		};
	}

	// =========================================================================
	// Internal state API (used by the Lifecycle Manager only)
	// =========================================================================

	getManifest(id: CapabilityId): CapabilityManifest | undefined {
		return this.entries.get(id)?.manifest;
	}

	getLoader(id: CapabilityId): CapabilityLoader | undefined {
		return this.entries.get(id)?.loader;
	}

	getLifecycle(id: CapabilityId): CapabilityLifecycle | undefined {
		return this.entries.get(id)?.lifecycle;
	}

	setState(id: CapabilityId, state: CapabilityState, error?: string): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		const previous = entry.state;
		entry.state = state;
		if (error !== undefined) entry.error = error;
		const info = this.toInfo(entry);
		for (const listener of this.listeners) {
			listener.onStateChanged(info, previous);
		}
	}

	setExports(
		id: CapabilityId,
		exports: CapabilityExports,
		context: CapabilityContext,
		lifecycle: CapabilityLifecycle,
	): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.exports = exports;
		entry.context = context;
		entry.lifecycle = lifecycle;
		entry.loadedAt = Date.now();
	}

	clearExports(id: CapabilityId): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.exports = undefined;
		entry.context = undefined;
		entry.lifecycle = undefined;
		entry.loadedAt = undefined;
	}

	reportError(id: CapabilityId, error: Error): void {
		for (const listener of this.listeners) {
			listener.onError(id, error);
		}
	}

	private toInfo(entry: RegistryEntry): RuntimeCapabilityInfo {
		return {
			manifest: entry.manifest,
			state: entry.state,
			error: entry.error,
			loadedAt: entry.loadedAt,
		};
	}
}
