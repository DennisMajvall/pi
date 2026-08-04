import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CapabilityManifest, CapabilityRequires } from "../src/capability/index.ts";
import { CapabilityState } from "../src/capability/index.ts";
import { PlatformError } from "../src/error/index.ts";
import type { PlatformEvent } from "../src/event/index.ts";
import { type CapabilityId, capabilityId, capabilityVersion, sessionId, workspaceId } from "../src/identifier/index.ts";
import type { BuiltinCapability } from "../src/kernel/discovery.ts";
import { KernelEventBus } from "../src/kernel/event-bus.ts";
import { EVENT_READY, EVENT_SHUTDOWN } from "../src/kernel/events.ts";
import { createRuntime, type KernelRuntime } from "../src/kernel/index.ts";
import { KernelLifecycleManager } from "../src/kernel/lifecycle.ts";
import { KernelCapabilityRegistry } from "../src/kernel/registry.ts";
import { SimpleCapabilityResolver } from "../src/kernel/resolver.ts";
import { KernelServiceProvider } from "../src/kernel/service-provider.ts";
import type { Session, SessionService, SettingsService } from "../src/service/index.ts";

let runtime: KernelRuntime | undefined;

function manifest(id: string, requires: CapabilityId[] = []): CapabilityManifest {
	return {
		schemaVersion: 1,
		id: capabilityId(id),
		version: capabilityVersion("1.0.0"),
		category: "tool",
		provides: {
			tool: { name: id, description: `fixture ${id}`, parameters: {} },
		},
		requires: {
			services: [],
			capabilities: requires.map((dep) => ({ id: dep, version: "^1.0.0" })),
		},
		permissions: {},
		compatibility: { runtime: ">=0.83.0", peers: {} },
		metadata: { name: id, description: `fixture ${id}`, tags: ["test"] },
	};
}

/** Fixture factory recording init/shutdown order and optionally using the fs service. */
function factory(id: string, initLog: string[], shutdownLog: string[], useFs = false): BuiltinCapability["factory"] {
	return async (ctx) => ({
		async init() {
			initLog.push(id);
			if (useFs) {
				// Real service injection through the capability context.
				await ctx.fs.exists("/");
			}
			return { marker: id };
		},
		async shutdown() {
			shutdownLog.push(id);
		},
	});
}

function fixtureCapability(
	id: string,
	requires: CapabilityId[],
	initLog: string[],
	shutdownLog: string[],
	useFs = false,
): BuiltinCapability {
	return {
		manifest: manifest(id, requires),
		factory: factory(id, initLog, shutdownLog, useFs),
	};
}

async function boot(builtins: BuiltinCapability[]): Promise<KernelRuntime> {
	const kernel = createRuntime({ builtins, services: { workspaceRoot: "/" } });
	await kernel.initialize();
	await kernel.start();
	return kernel;
}

afterEach(async () => {
	if (runtime) {
		await runtime.shutdown();
		runtime = undefined;
	}
});

describe("kernel: walking skeleton pipeline", () => {
	it("runs discovery → registration → resolution → init → ready for a single capability", async () => {
		const initLog: string[] = [];
		const shutdownLog: string[] = [];
		runtime = await boot([fixtureCapability("tool.alpha", [], initLog, shutdownLog)]);

		const info = runtime.capabilities.get(capabilityId("tool.alpha"));
		expect(info?.state).toBe(CapabilityState.Ready);
		expect(info?.manifest.id).toBe(capabilityId("tool.alpha"));
		expect(initLog).toEqual(["tool.alpha"]);

		// exports available through the registry
		const exports = runtime.capabilities.getExports<{ marker: string }>(capabilityId("tool.alpha"));
		expect(exports?.marker).toBe("tool.alpha");
	});

	it("initializes dependencies before dependents and shuts down in reverse", async () => {
		const initLog: string[] = [];
		const shutdownLog: string[] = [];
		const alpha = fixtureCapability("tool.alpha", [], initLog, shutdownLog);
		const beta = fixtureCapability("tool.beta", [capabilityId("tool.alpha")], initLog, shutdownLog);
		const gamma = fixtureCapability("tool.gamma", [capabilityId("tool.beta")], initLog, shutdownLog);
		runtime = await boot([alpha, beta, gamma]);

		expect(initLog).toEqual(["tool.alpha", "tool.beta", "tool.gamma"]);

		await runtime.shutdown();
		expect(shutdownLog).toEqual(["tool.gamma", "tool.beta", "tool.alpha"]);
	});

	it("exposes capability contexts for consumer execution contexts", async () => {
		runtime = await boot([fixtureCapability("tool.alpha", [], [], [])]);
		const context = runtime.capabilities.getContext(capabilityId("tool.alpha"));
		expect(context?.capabilityId).toBe(capabilityId("tool.alpha"));
	});

	it("injects the FileSystemService through the capability context", async () => {
		runtime = await boot([fixtureCapability("tool.fs", [], [], [], true)]);
		const info = runtime.capabilities.get(capabilityId("tool.fs"));
		expect(info?.state).toBe(CapabilityState.Ready);
	});

	it("injects a supplied SettingsService override through the capability context", async () => {
		const settingsStub: SettingsService = {
			get: () => undefined,
			getAll: () => ({}),
			set: async () => {},
			registerSchema: () => {},
			subscribe: () => () => {},
			subscribeAny: () => () => {},
			load: async () => {},
			save: async () => {},
			reset: async () => {},
			getSettingsPath: () => "",
		};
		runtime = createRuntime({
			builtins: [fixtureCapability("tool.alpha", [], [], [])],
			services: { workspaceRoot: "/", settings: settingsStub },
		});
		await runtime.initialize();
		await runtime.start();

		expect(runtime.services.settings).toBe(settingsStub);
		expect(runtime.capabilities.getContext(capabilityId("tool.alpha"))?.settings).toBe(settingsStub);
	});

	it("injects a supplied SessionService override through the capability context", async () => {
		const stubSession: Session = {
			id: sessionId("stub"),
			workspaceId: workspaceId("stub"),
			cwd: "/",
			createdAt: 0,
			updatedAt: 0,
			append: async () => {},
			getEntries: async () => [],
			getHeader: () => ({ version: 1, id: sessionId("stub"), cwd: "/", createdAt: 0 }),
			updateInfo: async () => {},
			close: async () => {},
		};
		const sessionStub: SessionService = {
			create: async () => stubSession,
			open: async () => stubSession,
			fork: async () => stubSession,
			list: async () => [],
			delete: async () => {},
			export: async () => ({ content: "", mimeType: "", filename: "" }),
			import: async () => stubSession,
		};
		runtime = createRuntime({
			builtins: [fixtureCapability("tool.alpha", [], [], [])],
			services: { workspaceRoot: "/", session: sessionStub },
		});
		await runtime.initialize();
		await runtime.start();

		expect(runtime.services.session).toBe(sessionStub);
		expect(runtime.capabilities.getContext(capabilityId("tool.alpha"))?.session).toBe(sessionStub);
	});

	it("exposes glob/list through the capability context (real fs service)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-kernel-fs-"));
		try {
			writeFileSync(join(dir, "a.md"), "");
			mkdirSync(join(dir, "sub"));
			writeFileSync(join(dir, "sub", "b.md"), "");
			const fsQuery: BuiltinCapability = {
				manifest: manifest("tool.fsquery", []),
				factory: async (ctx) => ({
					async init() {
						return {
							globbed: await ctx.fs.glob("**/*.md"),
							listed: (await ctx.fs.list(".", { includeHidden: true })).map((s) => s.name),
						};
					},
					async shutdown() {},
				}),
			};
			runtime = createRuntime({
				builtins: [fsQuery],
				services: { workspaceRoot: dir },
			});
			await runtime.initialize();
			await runtime.start();

			const exports = runtime.capabilities.getExports<{ globbed: string[]; listed: string[] }>(
				capabilityId("tool.fsquery"),
			);
			expect(exports?.globbed).toEqual(["a.md", "sub/b.md"]);
			expect(exports?.listed).toContain("a.md");
			expect(exports?.listed).toContain("sub");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reports missing dependencies without crashing", async () => {
		runtime = await boot([fixtureCapability("tool.orphan", [capabilityId("tool.ghost")], [], [])]);
		expect(runtime.capabilities.get(capabilityId("tool.orphan"))?.state).toBe(CapabilityState.Ready);
	});

	it("marks failed capabilities as error and contains the failure", async () => {
		const failing: BuiltinCapability = {
			manifest: manifest("tool.fail"),
			factory: async () => ({
				async init() {
					throw new Error("boom");
				},
			}),
		};
		runtime = await boot([failing]);
		const info = runtime.capabilities.get(capabilityId("tool.fail"));
		expect(info?.state).toBe(CapabilityState.Error);
		expect(info?.error).toContain("boom");
	});

	it("throws on unknown services (not-implemented stubs)", async () => {
		const instance = await boot([fixtureCapability("tool.alpha", [], [], [])]);
		runtime = instance;
		expect(() => instance.services.settings.get("anything")).toThrow(PlatformError);
		expect(() => instance.services.session.create({ workspaceId: workspaceId("ws"), cwd: "/" })).toThrow(
			PlatformError,
		);
	});

	it("detects dependency cycles via the resolver", async () => {
		const bus = new KernelEventBus();
		const registry = new KernelCapabilityRegistry(bus);
		const services = new KernelServiceProvider({ workspaceRoot: "/" });
		const resolver = new SimpleCapabilityResolver((id) => registry.get(id)?.manifest);
		const lifecycle = new KernelLifecycleManager({
			registry,
			resolver,
			events: bus,
			createContext: (id) => {
				const info = registry.get(id);
				return {
					settings: services.settings,
					session: services.session,
					fs: services.fs,
					process: services.process,
					network: services.network,
					auth: services.auth,
					cache: services.cache,
					events: bus,
					permissions: services.permissions,
					logging: services.logging,
					configuration: services.configuration,
					telemetry: services.telemetry,
					capabilities: registry,
					capabilityId: id,
					capabilityVersion: info?.manifest.version ?? capabilityVersion("0.0.0"),
					sourceInfo: { type: "builtin", path: id },
				};
			},
		});
		const cycleA = fixtureCapability("tool.cycle-a", [capabilityId("tool.cycle-b")], [], []);
		const cycleB = fixtureCapability("tool.cycle-b", [capabilityId("tool.cycle-a")], [], []);
		for (const c of [cycleA, cycleB]) {
			await registry.register(c.manifest, { load: c.factory });
		}
		const graph = await resolver.resolve([capabilityId("tool.cycle-a"), capabilityId("tool.cycle-b")]);
		expect(graph.cycles.length).toBeGreaterThan(0);

		// restart is not implemented
		await expect(lifecycle.restart(capabilityId("tool.cycle-a"))).rejects.toBeInstanceOf(PlatformError);
	});
});

describe("kernel: event bus", () => {
	it("delivers typed events synchronously in subscription order", async () => {
		const instance = await boot([fixtureCapability("tool.alpha", [], [], [])]);
		runtime = instance;
		const received: string[] = [];
		const unsubscribe = instance.events.subscribe(EVENT_READY, () => {
			received.push("first");
		});
		instance.events.subscribe(EVENT_READY, () => {
			received.push("second");
		});

		await instance.events.emit({ type: EVENT_READY, id: "x", payload: {}, metadata: {} } as PlatformEvent);
		expect(received).toEqual(["first", "second"]);

		unsubscribe();
		received.length = 0;
		await instance.events.emit({ type: EVENT_READY, id: "y", payload: {}, metadata: {} } as PlatformEvent);
		expect(received).toEqual(["second"]);
	});

	it("honors filters and rejects replay requests", async () => {
		const instance = await boot([fixtureCapability("tool.alpha", [], [], [])]);
		runtime = instance;
		const received: string[] = [];
		instance.events.subscribe(
			EVENT_READY,
			() => {
				received.push("ready");
			},
			{ filter: (event) => event.type === EVENT_READY },
		);
		await instance.events.emit({ type: EVENT_SHUTDOWN, id: "x", payload: {}, metadata: {} } as PlatformEvent);
		expect(received).toEqual([]);

		expect(() => instance.events.subscribe(EVENT_READY, () => {}, { replay: true })).toThrow(PlatformError);
	});
});

describe("kernel: registry queries", () => {
	it("supports category, provides, and state queries", async () => {
		const instance = await boot([fixtureCapability("tool.alpha", [], [], [])]);
		runtime = instance;
		expect(instance.capabilities.getByCategory("tool")).toHaveLength(1);
		expect(instance.capabilities.find({ provides: "tool" })).toHaveLength(1);
		expect(instance.capabilities.find({ state: CapabilityState.Ready })).toHaveLength(1);
	});
});

describe("kernel: manifest schema validation", () => {
	async function registerManifest(manifest: CapabilityManifest): Promise<unknown> {
		const bus = new KernelEventBus();
		const registry = new KernelCapabilityRegistry(bus);
		return registry.register(manifest, { load: async () => ({ init: async () => ({}) }) });
	}

	it("accepts schema-conformant manifests at registration", async () => {
		await expect(registerManifest(manifest("tool.valid"))).resolves.toBeDefined();
	});

	it("rejects a manifest with an invalid capability id", async () => {
		const bad = manifest("tool.valid");
		bad.id = "not-an-id" as CapabilityId;
		await expect(registerManifest(bad)).rejects.toThrow(/validation/i);
	});

	it("rejects a manifest with an unknown required service", async () => {
		const bad = manifest("tool.valid");
		bad.requires.services = ["ghost-service" as CapabilityRequires["services"][number]];
		await expect(registerManifest(bad)).rejects.toThrow(/validation/i);
	});

	it("rejects a manifest missing required metadata fields", async () => {
		const bad = manifest("tool.valid");
		bad.metadata = { name: "x" } as CapabilityManifest["metadata"];
		await expect(registerManifest(bad)).rejects.toThrow(/validation/i);
	});

	it("rejects a manifest with an invalid permission level", async () => {
		const bad = manifest("tool.valid");
		bad.permissions = { process: "teleport" } as unknown as CapabilityManifest["permissions"];
		await expect(registerManifest(bad)).rejects.toThrow(/validation/i);
	});
});
