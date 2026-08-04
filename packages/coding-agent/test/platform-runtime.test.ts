/**
 * Integration test for the Step 1.3 walking skeleton: the real `read`
 * builtin capability traverses the complete platform lifecycle and is
 * consumable by existing coding-agent tool paths.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCapabilityExport } from "@earendil-works/pi-platform/capability";
import { CapabilityState } from "@earendil-works/pi-platform/capability";
import { capabilityId, sessionId } from "@earendil-works/pi-platform/identifier";
import { createRuntime, type KernelRuntime } from "@earendil-works/pi-platform/kernel";
import type { SettingsService } from "@earendil-works/pi-platform/service";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	ensurePlatformRuntime,
	getPlatformFindToolDefinition,
	getPlatformLsToolDefinition,
	getPlatformReadToolDefinition,
	getPlatformRuntime,
	shutdownPlatformRuntime,
} from "../src/platform/platform-runtime.ts";
import { readCapability } from "../src/platform/read-capability.ts";
import type { SessionManagerService } from "../src/platform/session-service.ts";
import { SettingsManagerService } from "../src/platform/settings-service.ts";

const READ_ID = capabilityId("tool.read");

let kernel: KernelRuntime | undefined;
const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-platform-read-"));
	tempDirs.push(dir);
	return dir;
}

function writeFixture(dir: string): string {
	const file = join(dir, "fixture.txt");
	writeFileSync(file, ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n"));
	return file;
}

async function bootReadKernel(settings?: SettingsService): Promise<KernelRuntime> {
	const instance = createRuntime({
		builtins: [readCapability],
		services: {
			workspaceRoot: process.cwd(),
			settings: settings ?? new SettingsManagerService(SettingsManager.inMemory()),
		},
	});
	await instance.initialize();
	await instance.start();
	return instance;
}

async function readToolExport(instance: KernelRuntime): Promise<ToolCapabilityExport> {
	const exports = instance.capabilities.getExports<{ tool: ToolCapabilityExport }>(READ_ID);
	if (!exports?.tool) throw new Error("read exports missing");
	return exports.tool;
}

async function readCapabilityContext(instance: KernelRuntime) {
	const context = instance.capabilities.getContext(READ_ID);
	if (!context) throw new Error("read context missing");
	return context;
}

afterEach(async () => {
	await shutdownPlatformRuntime();
	if (kernel) {
		await kernel.shutdown();
		kernel = undefined;
	}
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

/** SettingsService spy: records every get path (transport-retirement proof). */
class RecordingSettingsService extends SettingsManagerService {
	readonly paths: string[] = [];

	get<T>(path: string, defaultValue?: T): T | undefined {
		this.paths.push(path);
		return super.get(path, defaultValue);
	}
}

describe("platform read capability: full lifecycle", () => {
	it("is discovered, registered, resolved, initialized, ready, and shuts down", async () => {
		kernel = await bootReadKernel();

		const info = kernel.capabilities.get(READ_ID);
		expect(info).toBeDefined();
		expect(info?.state).toBe(CapabilityState.Ready);
		expect(info?.manifest.category).toBe("tool");
		expect(info?.manifest.requires.services).toContain("fs");

		// exports available through the registry
		const tool = await readToolExport(kernel);
		expect(tool.definition.name).toBe("read");

		await kernel.shutdown();
		expect(kernel.capabilities.get(READ_ID)?.state).toBe(CapabilityState.Unloaded);
	});

	it("executes reads through the capability (service-injected fs)", async () => {
		kernel = await bootReadKernel();
		const dir = makeTempDir();
		const file = writeFixture(dir);
		const tool = await readToolExport(kernel);
		const context = await readCapabilityContext(kernel);

		const result = await tool.execute(
			{ path: file },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(result.success).toBe(true);
		const output = result.output as { content: Array<{ type: string; text?: string }> };
		const text = output.content.map((part) => part.text ?? "").join("");
		expect(text).toContain("line 1");
		expect(text).toContain("line 5");
	});

	it("honors offset/limit and relative paths against the execution cwd", async () => {
		kernel = await bootReadKernel();
		const dir = makeTempDir();
		writeFixture(dir);
		const tool = await readToolExport(kernel);
		const context = await readCapabilityContext(kernel);

		const result = await tool.execute(
			{ path: "fixture.txt", offset: 2, limit: 2 },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(result.success).toBe(true);
		const output = result.output as { content: Array<{ type: string; text?: string }> };
		const text = output.content.map((part) => part.text ?? "").join("");
		expect(text).toContain("line 2");
		expect(text).toContain("line 3");
		expect(text).not.toContain("line 5");
	});

	it("reports errors (missing file) through ToolResult", async () => {
		kernel = await bootReadKernel();
		const dir = makeTempDir();
		const tool = await readToolExport(kernel);
		const context = await readCapabilityContext(kernel);

		const result = await tool.execute(
			{ path: "missing.txt" },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("ENOENT");
	});

	it("reads image auto-resize from the settings service (metadata transport retired)", async () => {
		const recording = new RecordingSettingsService(SettingsManager.inMemory());
		kernel = await bootReadKernel(recording);
		const dir = makeTempDir();
		const file = writeFixture(dir);
		const tool = await readToolExport(kernel);
		const context = await readCapabilityContext(kernel);

		const result = await tool.execute(
			{ path: file },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				// No settings ride through metadata anymore.
				metadata: {},
			},
		);
		expect(result.success).toBe(true);
		const output = result.output as { content: Array<{ type: string; text?: string }> };
		const text = output.content.map((part) => part.text ?? "").join("");
		expect(text).toContain("line 1");
		// The capability read the setting through ctx.settings, not metadata.
		expect(recording.paths).toContain("images.autoResize");
	});
});

describe("coding-agent consumption adapter", () => {
	it("returns undefined when the kernel is not booted (fallback path)", () => {
		expect(getPlatformReadToolDefinition(process.cwd(), {})).toBeUndefined();
	});

	it("builds a working AgentSession ToolDefinition from registry exports", async () => {
		await ensurePlatformRuntime();
		const dir = makeTempDir();
		const file = writeFixture(dir);

		const definition = getPlatformReadToolDefinition(dir, { sessionId: "test" });
		expect(definition).toBeDefined();
		expect(definition?.name).toBe("read");

		const result = await definition!.execute(
			"call-1",
			{ path: file },
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);
		const text = (result.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? "").join("");
		expect(text).toContain("line 1");
	});

	it("binds the booted session service to the supplied session manager", async () => {
		const manager = SessionManager.inMemory();
		await ensurePlatformRuntime({ sessionManager: manager });
		const kernel = getPlatformRuntime();
		expect(kernel).toBeDefined();
		if (!kernel) return;

		const sessionService = kernel.services.session as SessionManagerService;
		expect(sessionService.getBootSession().id).toBe(sessionId(manager.getSessionId()));
	});

	it("builds a working AgentSession find ToolDefinition from registry exports", async () => {
		await ensurePlatformRuntime();
		const dir = makeTempDir();
		writeFileSync(join(dir, "x.ts"), "");

		const definition = getPlatformFindToolDefinition(dir, { sessionId: "test" });
		expect(definition).toBeDefined();
		expect(definition?.name).toBe("find");
		expect(typeof definition?.renderCall).toBe("function");
		expect(typeof definition?.renderResult).toBe("function");

		const result = await definition!.execute(
			"call-find-1",
			{ pattern: "*.ts", path: dir },
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);
		const text = (result.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? "").join("");
		expect(text).toContain("x.ts");
	});

	it("builds a working AgentSession ls ToolDefinition from registry exports", async () => {
		await ensurePlatformRuntime();
		const dir = makeTempDir();
		writeFileSync(join(dir, "entry.txt"), "");

		const definition = getPlatformLsToolDefinition(dir, { sessionId: "test" });
		expect(definition).toBeDefined();
		expect(definition?.name).toBe("ls");

		const result = await definition!.execute(
			"call-ls-1",
			{ path: dir },
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);
		const text = (result.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? "").join("");
		expect(text).toContain("entry.txt");
	});
});
