/**
 * Integration test for the Step 1.8 walking skeleton: the real `find` and
 * `ls` builtin capabilities traverse the complete platform lifecycle backed
 * by the FileSystemService's new glob/list operations, and are consumable by
 * existing coding-agent tool paths.
 *
 * The find tests cover both glob modes of the adapter: workspace-relative
 * patterns (workspace root = the temp dir) and absolute patterns (temp dir
 * outside the booted runtime's workspace root).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCapabilityExport } from "@earendil-works/pi-platform/capability";
import { CapabilityState } from "@earendil-works/pi-platform/capability";
import { capabilityId, sessionId } from "@earendil-works/pi-platform/identifier";
import { createRuntime, type KernelRuntime } from "@earendil-works/pi-platform/kernel";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { findCapability } from "../src/platform/find-capability.ts";
import { lsCapability } from "../src/platform/ls-capability.ts";
import {
	ensurePlatformRuntime,
	getPlatformFindToolDefinition,
	getPlatformLsToolDefinition,
	getPlatformRuntime,
	shutdownPlatformRuntime,
} from "../src/platform/platform-runtime.ts";

const FIND_ID = capabilityId("tool.find");
const LS_ID = capabilityId("tool.ls");

let kernel: KernelRuntime | undefined;
const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-platform-find-ls-"));
	tempDirs.push(dir);
	return dir;
}

function writeFixture(dir: string): void {
	mkdirSync(join(dir, "src", "deep"), { recursive: true });
	mkdirSync(join(dir, "node_modules"));
	mkdirSync(join(dir, ".git"));
	writeFileSync(join(dir, "a.ts"), "");
	writeFileSync(join(dir, "src", "b.ts"), "");
	writeFileSync(join(dir, "src", "deep", "c.ts"), "");
	writeFileSync(join(dir, "src", "x.spec.ts"), "");
	writeFileSync(join(dir, "node_modules", "ignored.ts"), "");
	writeFileSync(join(dir, ".git", "g.ts"), "");
	writeFileSync(join(dir, ".hidden.ts"), "");
	writeFileSync(join(dir, "visible.txt"), "");
	writeFileSync(join(dir, "src", "note.txt"), "");
}

async function bootFindLsKernel(workspaceRoot: string): Promise<KernelRuntime> {
	const instance = createRuntime({
		builtins: [findCapability, lsCapability],
		services: { workspaceRoot },
	});
	await instance.initialize();
	await instance.start();
	return instance;
}

async function toolExport(instance: KernelRuntime, id: ReturnType<typeof capabilityId>): Promise<ToolCapabilityExport> {
	const exports = instance.capabilities.getExports<{ tool: ToolCapabilityExport }>(id);
	if (!exports?.tool) throw new Error("tool exports missing");
	return exports.tool;
}

async function capabilityContext(instance: KernelRuntime, id: ReturnType<typeof capabilityId>) {
	const context = instance.capabilities.getContext(id);
	if (!context) throw new Error("capability context missing");
	return context;
}

interface ToolOutput {
	content: Array<{ type: string; text?: string }>;
}

function outputText(result: { output?: unknown }): string {
	const output = result.output as ToolOutput | undefined;
	return (output?.content ?? []).map((part) => part.text ?? "").join("");
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

describe("platform find capability: full lifecycle", () => {
	it("is discovered, registered, resolved, initialized, ready, and shuts down", async () => {
		kernel = await bootFindLsKernel(process.cwd());

		const info = kernel.capabilities.get(FIND_ID);
		expect(info).toBeDefined();
		expect(info?.state).toBe(CapabilityState.Ready);
		expect(info?.manifest.category).toBe("tool");
		expect(info?.manifest.requires.services).toContain("fs");
		expect(info?.manifest.permissions.fs).toBe("read");

		const tool = await toolExport(kernel, FIND_ID);
		expect(tool.definition.name).toBe("find");
		expect(tool.definition.parameters).toBeDefined();

		await kernel.shutdown();
		expect(kernel.capabilities.get(FIND_ID)?.state).toBe(CapabilityState.Unloaded);
	});

	it("finds files by recursive basename pattern (fs.glob-backed, no fd)", async () => {
		const dir = makeTempDir();
		writeFixture(dir);
		kernel = await bootFindLsKernel(dir);
		const tool = await toolExport(kernel, FIND_ID);
		const context = await capabilityContext(kernel, FIND_ID);

		const result = await tool.execute(
			{ pattern: "*.ts", path: dir },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(result.success).toBe(true);
		const text = outputText(result).trim();
		const lines = text.split("\n");
		// Recursive basename matching: .ts files at any depth under the search
		// path, ignoring node_modules/.git (adapter ignore list) and dotfiles.
		expect(lines).toContain("a.ts");
		expect(lines).toContain("src/b.ts");
		expect(lines).toContain("src/deep/c.ts");
		expect(lines).toContain("src/x.spec.ts");
		expect(lines).not.toContain("node_modules/ignored.ts");
		expect(lines).not.toContain(".git/g.ts");
		expect(lines).not.toContain(".hidden.ts");
	});

	it("honors the execution cwd and path-relative patterns", async () => {
		const dir = makeTempDir();
		writeFixture(dir);
		kernel = await bootFindLsKernel(dir);
		const tool = await toolExport(kernel, FIND_ID);
		const context = await capabilityContext(kernel, FIND_ID);

		const result = await tool.execute(
			{ pattern: "**/*.ts", path: "src" },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(result.success).toBe(true);
		const lines = outputText(result).trim().split("\n");
		expect(lines).toContain("b.ts");
		expect(lines).toContain("deep/c.ts");
		expect(lines).toContain("x.spec.ts");
		expect(lines).not.toContain("a.ts");
	});

	it("reports no matches and missing paths through ToolResult", async () => {
		const dir = makeTempDir();
		writeFixture(dir);
		kernel = await bootFindLsKernel(dir);
		const tool = await toolExport(kernel, FIND_ID);
		const context = await capabilityContext(kernel, FIND_ID);

		const none = await tool.execute(
			{ pattern: "**/*.xyz" },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(none.success).toBe(true);
		expect(outputText(none)).toContain("No files found matching pattern");

		const missing = await tool.execute(
			{ pattern: "*.ts", path: join(dir, "nope") },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(missing.success).toBe(false);
		expect(missing.error).toContain("Path not found");
	});

	it("searches outside the workspace root via absolute patterns", async () => {
		const outside = makeTempDir();
		writeFixture(outside);
		// The kernel's workspace root is a different temp dir, so the search
		// path is outside it — the adapter falls back to absolute patterns.
		kernel = await bootFindLsKernel(makeTempDir());
		const tool = await toolExport(kernel, FIND_ID);
		const context = await capabilityContext(kernel, FIND_ID);

		const result = await tool.execute(
			{ pattern: "*.ts", path: outside },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: outside,
				metadata: {},
			},
		);
		expect(result.success).toBe(true);
		const lines = outputText(result).trim().split("\n");
		expect(lines).toContain("a.ts");
		expect(lines).toContain("src/b.ts");
	});
});

describe("platform ls capability: full lifecycle", () => {
	it("is discovered, registered, resolved, initialized, ready, and shuts down", async () => {
		kernel = await bootFindLsKernel(process.cwd());

		const info = kernel.capabilities.get(LS_ID);
		expect(info).toBeDefined();
		expect(info?.state).toBe(CapabilityState.Ready);
		expect(info?.manifest.category).toBe("tool");
		expect(info?.manifest.requires.services).toContain("fs");
		expect(info?.manifest.permissions.fs).toBe("read");

		const tool = await toolExport(kernel, LS_ID);
		expect(tool.definition.name).toBe("ls");

		await kernel.shutdown();
		expect(kernel.capabilities.get(LS_ID)?.state).toBe(CapabilityState.Unloaded);
	});

	it("lists entries with dotfiles and directory suffixes (fs.list-backed)", async () => {
		const dir = makeTempDir();
		writeFixture(dir);
		kernel = await bootFindLsKernel(dir);
		const tool = await toolExport(kernel, LS_ID);
		const context = await capabilityContext(kernel, LS_ID);

		const result = await tool.execute(
			{ path: dir },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(result.success).toBe(true);
		const lines = outputText(result).trim().split("\n");
		expect(lines).toContain(".git/");
		expect(lines).toContain(".hidden.ts");
		expect(lines).toContain("src/");
		expect(lines).toContain("a.ts");
		expect(lines).toContain("visible.txt");
	});

	it("lists a subdirectory relative to the execution cwd", async () => {
		const dir = makeTempDir();
		writeFixture(dir);
		kernel = await bootFindLsKernel(dir);
		const tool = await toolExport(kernel, LS_ID);
		const context = await capabilityContext(kernel, LS_ID);

		const result = await tool.execute(
			{ path: "src" },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(result.success).toBe(true);
		const lines = outputText(result).trim().split("\n");
		expect(lines).toContain("b.ts");
		expect(lines).toContain("deep/");
		expect(lines).toContain("x.spec.ts");
		expect(lines).not.toContain("a.ts");
	});

	it("reports errors (missing path, file path) through ToolResult", async () => {
		const dir = makeTempDir();
		writeFixture(dir);
		kernel = await bootFindLsKernel(dir);
		const tool = await toolExport(kernel, LS_ID);
		const context = await capabilityContext(kernel, LS_ID);

		const missing = await tool.execute(
			{ path: join(dir, "nope") },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(missing.success).toBe(false);
		expect(missing.error).toContain("Path not found");

		const filePath = await tool.execute(
			{ path: join(dir, "a.ts") },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(filePath.success).toBe(false);
		expect(filePath.error).toContain("Not a directory");
	});
});

describe("platform runtime with find + ls builtins", () => {
	it("registers both builtins alongside the existing read-only set", async () => {
		await ensurePlatformRuntime();
		const kernelInstance = getPlatformRuntime();
		expect(kernelInstance).toBeDefined();
		expect(kernelInstance?.capabilities.get(FIND_ID)?.state).toBe(CapabilityState.Ready);
		expect(kernelInstance?.capabilities.get(LS_ID)?.state).toBe(CapabilityState.Ready);
	});
});

describe("coding-agent consumption adapter", () => {
	it("returns undefined when the kernel is not booted (fallback path)", () => {
		expect(getPlatformFindToolDefinition(process.cwd(), {})).toBeUndefined();
		expect(getPlatformLsToolDefinition(process.cwd(), {})).toBeUndefined();
	});

	it("builds working AgentSession ToolDefinitions from registry exports", async () => {
		await ensurePlatformRuntime();
		const dir = makeTempDir();
		writeFixture(dir);

		const findDefinition = getPlatformFindToolDefinition(dir, { sessionId: "test" });
		expect(findDefinition).toBeDefined();
		expect(findDefinition?.name).toBe("find");
		expect(typeof findDefinition?.renderCall).toBe("function");
		expect(typeof findDefinition?.renderResult).toBe("function");

		const findResult = await findDefinition!.execute(
			"call-1",
			{ pattern: "*.ts", path: dir },
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);
		const findText = (findResult.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? "").join("");
		expect(findText).toContain("a.ts");
		expect(findText).toContain("src/b.ts");

		const lsDefinition = getPlatformLsToolDefinition(dir, { sessionId: "test" });
		expect(lsDefinition).toBeDefined();
		expect(lsDefinition?.name).toBe("ls");

		const lsResult = await lsDefinition!.execute(
			"call-2",
			{ path: dir },
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);
		const lsText = (lsResult.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? "").join("");
		expect(lsText).toContain("src/");
		expect(lsText).toContain("a.ts");
	});
});
