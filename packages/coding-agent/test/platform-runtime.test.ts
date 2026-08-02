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
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import {
	ensurePlatformRuntime,
	getPlatformReadToolDefinition,
	shutdownPlatformRuntime,
} from "../src/platform/platform-runtime.ts";
import { readCapability } from "../src/platform/read-capability.ts";

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

async function bootReadKernel(): Promise<KernelRuntime> {
	const instance = createRuntime({
		builtins: [readCapability],
		services: { workspaceRoot: process.cwd() },
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
});
