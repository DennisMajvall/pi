/**
 * Integration test for the Step 1.6 extraction: the real SettingsService
 * (SettingsManagerService) adapts the existing SettingsManager behind the
 * platform contract, and the kernel injects it into capability contexts via
 * the KernelServiceProvider `settings` option.
 *
 * Scope honored: only the read side (get / getAll / load / save) is
 * implemented; the write/observe side throws NOT_IMPLEMENTED.
 */

import { PlatformError } from "@earendil-works/pi-platform/error";
import { capabilityId } from "@earendil-works/pi-platform/identifier";
import { createRuntime, type KernelRuntime } from "@earendil-works/pi-platform/kernel";
import type { SettingsService } from "@earendil-works/pi-platform/service";
import { afterEach, describe, expect, it } from "vitest";
import type { SettingsStorage } from "../src/core/settings-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { readCapability } from "../src/platform/read-capability.ts";
import { SettingsManagerService } from "../src/platform/settings-service.ts";

const READ_ID = capabilityId("tool.read");

let kernel: KernelRuntime | undefined;

/** Storage backend over two in-memory JSON strings (global/project scopes). */
function memoryStorage(global: string | undefined, project: string | undefined): SettingsStorage {
	let globalContent = global;
	let projectContent = project;
	return {
		withLock(scope, fn) {
			const current = scope === "global" ? globalContent : projectContent;
			const next = fn(current);
			if (next !== undefined) {
				if (scope === "global") {
					globalContent = next;
				} else {
					projectContent = next;
				}
			}
		},
	};
}

afterEach(async () => {
	if (kernel) {
		await kernel.shutdown();
		kernel = undefined;
	}
});

describe("SettingsManagerService: get / getAll over the effective settings", () => {
	it("resolves nested and top-level dotted paths from an in-memory manager", () => {
		const manager = SettingsManager.inMemory({
			shellCommandPrefix: "shopt -s expand_aliases",
			images: { autoResize: false },
		});
		const service: SettingsService = new SettingsManagerService(manager);

		expect(service.get<boolean>("images.autoResize")).toBe(false);
		expect(service.get<string>("shellCommandPrefix")).toBe("shopt -s expand_aliases");
	});

	it("returns the default when a path is missing, and undefined when no default is given", () => {
		const service: SettingsService = new SettingsManagerService(SettingsManager.inMemory());

		expect(service.get<boolean>("images.autoResize", true)).toBe(true);
		expect(service.get<string>("images.autoResize")).toBeUndefined();
		expect(service.get<string>("shellPath")).toBeUndefined();
		expect(service.get<string>("shellPath", "fallback")).toBe("fallback");
	});

	it("returns project settings merged over global settings (project wins)", () => {
		const storage = memoryStorage(
			JSON.stringify({ shellCommandPrefix: "global-prefix", shellPath: "global-shell" }),
			JSON.stringify({ shellCommandPrefix: "project-prefix", images: { autoResize: false } }),
		);
		const manager = SettingsManager.fromStorage(storage);
		const service: SettingsService = new SettingsManagerService(manager);

		expect(service.get<string>("shellCommandPrefix")).toBe("project-prefix");
		expect(service.get<string>("shellPath")).toBe("global-shell");
		expect(service.get<boolean>("images.autoResize", true)).toBe(false);
	});

	it("getAll reflects the merged snapshot including runtime overrides", () => {
		const manager = SettingsManager.inMemory({ shellCommandPrefix: "base" });
		manager.applyOverrides({ shellCommandPrefix: "overridden" });
		const service: SettingsService = new SettingsManagerService(manager);

		const all = service.getAll();
		expect(all.shellCommandPrefix).toBe("overridden");
	});

	it("load re-reads from storage (reload semantics)", async () => {
		const storage = memoryStorage(JSON.stringify({ shellCommandPrefix: "before" }), undefined);
		const manager = SettingsManager.fromStorage(storage);
		const service: SettingsService = new SettingsManagerService(manager);
		expect(service.get<string>("shellCommandPrefix")).toBe("before");

		// Mutate the underlying store, then load.
		storage.withLock("global", () => JSON.stringify({ shellCommandPrefix: "after" }));
		await service.load();
		expect(service.get<string>("shellCommandPrefix")).toBe("after");
	});

	it("save awaits the manager's write queue", async () => {
		const service: SettingsService = new SettingsManagerService(SettingsManager.inMemory());
		await expect(service.save()).resolves.toBeUndefined();
		await expect(service.load()).resolves.toBeUndefined();
	});
});

describe("SettingsManagerService: walking-skeleton scope (not implemented)", () => {
	function notImplementedMethods(): SettingsService {
		return new SettingsManagerService(SettingsManager.inMemory());
	}

	it("throws NOT_IMPLEMENTED for set / registerSchema / subscribe / subscribeAny / reset / getSettingsPath", async () => {
		const service = notImplementedMethods();
		const expectNotImplemented = (fn: () => unknown) => {
			try {
				fn();
				throw new Error("expected NOT_IMPLEMENTED throw");
			} catch (error) {
				expect(error).toBeInstanceOf(PlatformError);
				expect((error as PlatformError).code).toBe("NOT_IMPLEMENTED");
			}
		};

		expectNotImplemented(() => service.set("theme", "dark"));
		expectNotImplemented(() => service.registerSchema({ path: "theme", schema: {} }));
		expectNotImplemented(() => service.subscribe("theme", () => {}));
		expectNotImplemented(() => service.subscribeAny(() => {}));
		expectNotImplemented(() => service.reset("theme"));
		expectNotImplemented(() => service.getSettingsPath("global"));
	});
});

describe("kernel injection via KernelServiceProvider settings option", () => {
	it("injects the supplied SettingsService into capability contexts (stub not used)", async () => {
		const manager = SettingsManager.inMemory({ images: { autoResize: false } });
		const service = new SettingsManagerService(manager);
		kernel = createRuntime({
			builtins: [readCapability],
			services: { workspaceRoot: process.cwd(), settings: service },
		});
		await kernel.initialize();
		await kernel.start();

		const context = kernel.capabilities.getContext(READ_ID);
		expect(context?.settings).toBe(service);
		expect(context?.settings.get<boolean>("images.autoResize")).toBe(false);

		// The not-implemented stub is no longer installed for settings.
		expect(kernel.services.settings).toBe(service);
	});
});
