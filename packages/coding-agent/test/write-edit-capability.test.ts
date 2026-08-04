/**
 * Integration test for the Step 1.9 walking skeleton: the real `write` and
 * `edit` builtin capabilities traverse the complete platform lifecycle
 * backed by the FileSystemService's implemented write surface, exercising
 * the platform's first non-read permission (`permissions: { fs: "write" }`),
 * and are consumable by existing coding-agent tool paths.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCapabilityExport } from "@earendil-works/pi-platform/capability";
import { CapabilityState } from "@earendil-works/pi-platform/capability";
import { capabilityId, sessionId } from "@earendil-works/pi-platform/identifier";
import { createRuntime, type KernelRuntime } from "@earendil-works/pi-platform/kernel";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { editCapability } from "../src/platform/edit-capability.ts";
import {
	ensurePlatformRuntime,
	getPlatformEditToolDefinition,
	getPlatformRuntime,
	getPlatformWriteToolDefinition,
	shutdownPlatformRuntime,
} from "../src/platform/platform-runtime.ts";
import { writeCapability } from "../src/platform/write-capability.ts";

const WRITE_ID = capabilityId("tool.write");
const EDIT_ID = capabilityId("tool.edit");

let kernel: KernelRuntime | undefined;
const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-platform-write-edit-"));
	tempDirs.push(dir);
	return dir;
}

async function bootWriteEditKernel(workspaceRoot: string): Promise<KernelRuntime> {
	const instance = createRuntime({
		builtins: [writeCapability, editCapability],
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

async function executeTool(
	tool: ToolCapabilityExport,
	context: Awaited<ReturnType<typeof capabilityContext>>,
	dir: string,
	args: unknown,
): Promise<{ success: boolean; output?: unknown; error?: string }> {
	return tool.execute(args, {
		capability: context,
		signal: new AbortController().signal,
		sessionId: sessionId("test"),
		cwd: dir,
		metadata: {},
	});
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

describe("platform write capability: full lifecycle", () => {
	it("is discovered, registered, resolved, initialized, ready, and shuts down", async () => {
		kernel = await bootWriteEditKernel(process.cwd());

		const info = kernel.capabilities.get(WRITE_ID);
		expect(info).toBeDefined();
		expect(info?.state).toBe(CapabilityState.Ready);
		expect(info?.manifest.category).toBe("tool");
		expect(info?.manifest.requires.services).toContain("fs");
		// First non-read permission on the platform.
		expect(info?.manifest.permissions.fs).toBe("write");

		const tool = await toolExport(kernel, WRITE_ID);
		expect(tool.definition.name).toBe("write");
		expect(tool.definition.parameters).toBeDefined();

		await kernel.shutdown();
		expect(kernel.capabilities.get(WRITE_ID)?.state).toBe(CapabilityState.Unloaded);
	});

	it("writes a file and creates parent directories (fs.write/mkdir-backed)", async () => {
		const dir = makeTempDir();
		kernel = await bootWriteEditKernel(dir);
		const tool = await toolExport(kernel, WRITE_ID);
		const context = await capabilityContext(kernel, WRITE_ID);

		const result = await executeTool(tool, context, dir, {
			path: join(dir, "nested", "deep", "note.txt"),
			content: "hello platform",
		});
		expect(result.success).toBe(true);
		expect(outputText(result)).toContain("Successfully wrote");
		expect(outputText(result)).toContain("note.txt");
		expect(readFileSync(join(dir, "nested", "deep", "note.txt"), "utf-8")).toBe("hello platform");
	});

	it("overwrites an existing file", async () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "existing.txt"), "before");
		kernel = await bootWriteEditKernel(dir);
		const tool = await toolExport(kernel, WRITE_ID);
		const context = await capabilityContext(kernel, WRITE_ID);

		const result = await executeTool(tool, context, dir, {
			path: join(dir, "existing.txt"),
			content: "after",
		});
		expect(result.success).toBe(true);
		expect(readFileSync(join(dir, "existing.txt"), "utf-8")).toBe("after");
	});

	it("reports errors (missing parent blocked by file) through ToolResult", async () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "blocker"), "");
		kernel = await bootWriteEditKernel(dir);
		const tool = await toolExport(kernel, WRITE_ID);
		const context = await capabilityContext(kernel, WRITE_ID);

		const result = await executeTool(tool, context, dir, {
			path: join(dir, "blocker", "child.txt"),
			content: "x",
		});
		expect(result.success).toBe(false);
		expect(result.error).toBeDefined();
	});
});

describe("platform edit capability: full lifecycle", () => {
	it("is discovered, registered, resolved, initialized, ready, and shuts down", async () => {
		kernel = await bootWriteEditKernel(process.cwd());

		const info = kernel.capabilities.get(EDIT_ID);
		expect(info).toBeDefined();
		expect(info?.state).toBe(CapabilityState.Ready);
		expect(info?.manifest.category).toBe("tool");
		expect(info?.manifest.requires.services).toContain("fs");
		expect(info?.manifest.permissions.fs).toBe("write");

		const tool = await toolExport(kernel, EDIT_ID);
		expect(tool.definition.name).toBe("edit");

		await kernel.shutdown();
		expect(kernel.capabilities.get(EDIT_ID)?.state).toBe(CapabilityState.Unloaded);
	});

	it("replaces exact text through the capability (fs read/write-backed)", async () => {
		const dir = makeTempDir();
		const file = join(dir, "edit.txt");
		writeFileSync(file, "Hello, world!");
		kernel = await bootWriteEditKernel(dir);
		const tool = await toolExport(kernel, EDIT_ID);
		const context = await capabilityContext(kernel, EDIT_ID);

		const result = await executeTool(tool, context, dir, {
			path: file,
			edits: [{ oldText: "world", newText: "platform" }],
		});
		expect(result.success).toBe(true);
		expect(outputText(result)).toContain("Successfully replaced 1 block(s)");
		expect(readFileSync(file, "utf-8")).toBe("Hello, platform!");
		const details = (result.output as { details?: { diff?: string; patch?: string } }).details;
		expect(details?.diff).toContain("platform");
		expect(details?.patch).toContain("+Hello, platform!");
	});

	it("applies multiple disjoint edits in one call", async () => {
		const dir = makeTempDir();
		const file = join(dir, "multi.txt");
		writeFileSync(file, "alpha\nbeta\ngamma\n");
		kernel = await bootWriteEditKernel(dir);
		const tool = await toolExport(kernel, EDIT_ID);
		const context = await capabilityContext(kernel, EDIT_ID);

		const result = await executeTool(tool, context, dir, {
			path: file,
			edits: [
				{ oldText: "alpha\n", newText: "ALPHA\n" },
				{ oldText: "gamma\n", newText: "GAMMA\n" },
			],
		});
		expect(result.success).toBe(true);
		expect(outputText(result)).toContain("Successfully replaced 2 block(s)");
		expect(readFileSync(file, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\n");
	});

	it("reports ENOENT for a missing target (access probe)", async () => {
		const dir = makeTempDir();
		kernel = await bootWriteEditKernel(dir);
		const tool = await toolExport(kernel, EDIT_ID);
		const context = await capabilityContext(kernel, EDIT_ID);

		const result = await executeTool(tool, context, dir, {
			path: join(dir, "missing.txt"),
			edits: [{ oldText: "hello", newText: "world" }],
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain(`Could not edit file: ${join(dir, "missing.txt")}. Error code: ENOENT.`);
	});

	it("reports EACCES for a read-only file (access probe)", async () => {
		const dir = makeTempDir();
		const file = join(dir, "readonly.txt");
		writeFileSync(file, "hello\n");
		chmodSync(file, 0o444);
		kernel = await bootWriteEditKernel(dir);
		const tool = await toolExport(kernel, EDIT_ID);
		const context = await capabilityContext(kernel, EDIT_ID);

		const result = await executeTool(tool, context, dir, {
			path: file,
			edits: [{ oldText: "hello", newText: "world" }],
		});
		expect(result.success).toBe(false);
		expect(result.error).toContain(`Could not edit file: ${file}. Error code: EACCES.`);
	});

	it("preserves a UTF-8 BOM through the platform read/write path", async () => {
		const dir = makeTempDir();
		const file = join(dir, "bom.txt");
		writeFileSync(file, "\uFEFFline one\nline two\n");
		kernel = await bootWriteEditKernel(dir);
		const tool = await toolExport(kernel, EDIT_ID);
		const context = await capabilityContext(kernel, EDIT_ID);

		const result = await executeTool(tool, context, dir, {
			path: file,
			edits: [{ oldText: "line one", newText: "LINE ONE" }],
		});
		expect(result.success).toBe(true);
		expect(readFileSync(file, "utf-8")).toBe("\uFEFFLINE ONE\nline two\n");
	});
});

describe("platform runtime with write + edit builtins", () => {
	it("registers both builtins alongside the existing set", async () => {
		await ensurePlatformRuntime();
		const kernelInstance = getPlatformRuntime();
		expect(kernelInstance).toBeDefined();
		expect(kernelInstance?.capabilities.get(WRITE_ID)?.state).toBe(CapabilityState.Ready);
		expect(kernelInstance?.capabilities.get(EDIT_ID)?.state).toBe(CapabilityState.Ready);
	});
});

describe("coding-agent consumption adapter", () => {
	it("returns undefined when the kernel is not booted (fallback path)", () => {
		expect(getPlatformWriteToolDefinition(process.cwd(), {})).toBeUndefined();
		expect(getPlatformEditToolDefinition(process.cwd(), {})).toBeUndefined();
	});

	it("builds working AgentSession ToolDefinitions from registry exports", async () => {
		await ensurePlatformRuntime();
		const dir = makeTempDir();

		const writeDefinition = getPlatformWriteToolDefinition(dir, { sessionId: "test" });
		expect(writeDefinition).toBeDefined();
		expect(writeDefinition?.name).toBe("write");
		expect(typeof writeDefinition?.renderCall).toBe("function");
		expect(typeof writeDefinition?.renderResult).toBe("function");

		const writeResult = await writeDefinition!.execute(
			"call-1",
			{ path: join(dir, "out.txt"), content: "written through adapter" },
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);
		const writeText = (writeResult.content as Array<{ type: string; text?: string }>)
			.map((p) => p.text ?? "")
			.join("");
		expect(writeText).toContain("Successfully wrote");
		expect(readFileSync(join(dir, "out.txt"), "utf-8")).toBe("written through adapter");

		const editDefinition = getPlatformEditToolDefinition(dir, { sessionId: "test" });
		expect(editDefinition).toBeDefined();
		expect(editDefinition?.name).toBe("edit");
		// The edit definition carries the template's compatibility shim and
		// self-shell rendering (the agent loop runs prepareArguments before
		// schema validation; renderShell controls the TUI shell frame).
		expect(typeof editDefinition?.prepareArguments).toBe("function");
		expect(editDefinition?.renderShell).toBe("self");

		const editResult = await editDefinition!.execute(
			"call-2",
			{ path: join(dir, "out.txt"), edits: [{ oldText: "written through", newText: "edited through" }] },
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);
		const editText = (editResult.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? "").join("");
		expect(editText).toContain("Successfully replaced 1 block(s)");
		expect(readFileSync(join(dir, "out.txt"), "utf-8")).toBe("edited through adapter");
	});
});
