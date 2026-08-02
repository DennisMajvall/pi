/**
 * Platform SettingsService implementation: an adapter over the coding-agent
 * SettingsManager (Step 1.6 extraction).
 *
 * The kernel stays generic; the host supplies the real settings service
 * through KernelServiceProviderOptions at bootPlatformRuntime, following the
 * NodeProcessService precedent. Capabilities read configuration through
 * `ctx.settings.get(...)` instead of the execution-metadata bridge (read's
 * autoResizeImages, bash's commandPrefix/shellPath).
 *
 * Walking-skeleton scope: only the read side of the contract is implemented
 * (get / getAll, plus load/save mapped to the manager's own persistence
 * lifecycle). The write/observe side (set, registerSchema, subscribe,
 * subscribeAny, reset, getSettingsPath) throws NOT_IMPLEMENTED — SettingsManager
 * persists through per-field typed setters with modified-field tracking and
 * has no schema registry, change-notification emitter, or exposed storage
 * paths, so a generic dotted-path setter would replicate machinery that
 * belongs to the Workspaces phase.
 */

import { PlatformError } from "@earendil-works/pi-platform/error";
import type { SettingsChange, SettingsSchema, SettingsService } from "@earendil-works/pi-platform/service";
import type { SettingsManager } from "../core/settings-manager.ts";

function notImplemented(method: string): never {
	throw new PlatformError(`SettingsService.${method} is not implemented in the walking skeleton`, {
		code: "NOT_IMPLEMENTED",
		metadata: { method },
	});
}

/** Walk a dotted path ("images.autoResize") through a settings object. */
function getByPath(settings: Record<string, unknown>, path: string): unknown {
	let current: unknown = settings;
	for (const segment of path.split(".")) {
		if (current === null || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[segment];
	}
	return current;
}

export class SettingsManagerService implements SettingsService {
	private readonly manager: SettingsManager;

	constructor(manager: SettingsManager) {
		this.manager = manager;
	}

	get<T>(path: string, defaultValue?: T): T | undefined {
		const value = getByPath(this.manager.getEffectiveSettings() as Record<string, unknown>, path);
		return value === undefined ? defaultValue : (value as T);
	}

	getAll(): Record<string, unknown> {
		return this.manager.getEffectiveSettings() as unknown as Record<string, unknown>;
	}

	async load(): Promise<void> {
		await this.manager.reload();
	}

	async save(): Promise<void> {
		await this.manager.flush();
	}

	set(_path: string, _value: unknown): Promise<void> {
		notImplemented("set");
	}

	registerSchema(_schema: SettingsSchema): void {
		notImplemented("registerSchema");
	}

	subscribe(_path: string, _listener: (value: unknown, previous: unknown) => void): () => void {
		notImplemented("subscribe");
	}

	subscribeAny(_listener: (changes: SettingsChange[]) => void): () => void {
		notImplemented("subscribeAny");
	}

	reset(_path?: string): Promise<void> {
		notImplemented("reset");
	}

	getSettingsPath(_scope: "global" | "project" | "user"): string {
		notImplemented("getSettingsPath");
	}
}
