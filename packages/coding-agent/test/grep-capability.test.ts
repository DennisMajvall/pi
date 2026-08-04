/**
 * Integration test for the Step 1.5 walking skeleton: the real `grep`
 * builtin capability traverses the complete platform lifecycle with a
 * peer-capability dependency on `tool.read`, and is consumable by existing
 * coding-agent tool paths.
 *
 * The peer edge is exercised for real: the resolver initializes tool.read
 * before tool.grep, grep's adapter consumes the read capability's exported
 * `readTextFile` primitive for context lines, and a missing peer fails
 * grep's init (hard dependency) instead of crashing.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCapabilityExport } from "@earendil-works/pi-platform/capability";
import { CapabilityState } from "@earendil-works/pi-platform/capability";
import { capabilityId, sessionId } from "@earendil-works/pi-platform/identifier";
import {
	type BuiltinCapability,
	createRuntime,
	type KernelRuntime,
	NodeProcessService,
} from "@earendil-works/pi-platform/kernel";
import type { ProcessHandle, ProcessService, SpawnOptions } from "@earendil-works/pi-platform/service";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { grepCapability } from "../src/platform/grep-capability.ts";
import {
	ensurePlatformRuntime,
	getPlatformGrepToolDefinition,
	getPlatformRuntime,
	shutdownPlatformRuntime,
} from "../src/platform/platform-runtime.ts";
import { readCapability, readManifest } from "../src/platform/read-capability.ts";

const GREP_ID = capabilityId("tool.grep");
const READ_ID = capabilityId("tool.read");
const BASH_ID = capabilityId("tool.bash");

let kernel: KernelRuntime | undefined;
const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-platform-grep-"));
	tempDirs.push(dir);
	return dir;
}

function writeFixture(dir: string, name = "fixture.txt"): string {
	const file = join(dir, name);
	writeFileSync(file, ["alpha one", "beta two", "alpha three", "plain"].join("\n"));
	return file;
}

/** ProcessService spy: records every spawn (the search-seam proof). */
class RecordingProcessService extends NodeProcessService {
	readonly spawns: Array<{ command: string; args: string[] }> = [];

	override spawn(command: string, args: string[], options: SpawnOptions = {}): ProcessHandle {
		this.spawns.push({ command, args });
		return super.spawn(command, args, options);
	}
}

async function bootGrepKernel(
	builtins: readonly BuiltinCapability[] = [readCapability, grepCapability],
	processService?: ProcessService,
): Promise<KernelRuntime> {
	const instance = createRuntime({
		builtins,
		services: {
			workspaceRoot: process.cwd(),
			...(processService ? { process: processService } : {}),
		},
	});
	await instance.initialize();
	await instance.start();
	return instance;
}

async function grepToolExport(instance: KernelRuntime): Promise<ToolCapabilityExport> {
	const exports = instance.capabilities.getExports<{ tool: ToolCapabilityExport }>(GREP_ID);
	if (!exports?.tool) throw new Error("grep exports missing");
	return exports.tool;
}

async function grepCapabilityContext(instance: KernelRuntime) {
	const context = instance.capabilities.getContext(GREP_ID);
	if (!context) throw new Error("grep context missing");
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

describe("platform grep capability: full lifecycle with peer dependency", () => {
	it("initializes read before grep (peer init order) and shuts both down", async () => {
		kernel = await bootGrepKernel();

		const readInfo = kernel.capabilities.get(READ_ID);
		const grepInfo = kernel.capabilities.get(GREP_ID);
		expect(readInfo?.state).toBe(CapabilityState.Ready);
		expect(grepInfo?.state).toBe(CapabilityState.Ready);
		expect(grepInfo?.manifest.category).toBe("tool");
		expect(grepInfo?.manifest.requires.services).toContain("fs");
		expect(grepInfo?.manifest.requires.services).toContain("process");
		expect(grepInfo?.manifest.requires.capabilities).toContainEqual({ id: READ_ID, version: "*" });
		expect(grepInfo?.manifest.permissions.fs).toBe("read");
		expect(grepInfo?.manifest.permissions.process).toBe("spawn");
		// Dependency-aware init order: read was made ready before grep.
		expect(readInfo?.loadedAt).toBeDefined();
		expect(grepInfo?.loadedAt).toBeDefined();
		expect(readInfo!.loadedAt!).toBeLessThanOrEqual(grepInfo!.loadedAt!);

		// exports available through the registry
		const tool = await grepToolExport(kernel);
		expect(tool.definition.name).toBe("grep");
		expect(tool.definition.parameters).toBeDefined();

		await kernel.shutdown();
		expect(kernel.capabilities.get(GREP_ID)?.state).toBe(CapabilityState.Unloaded);
		expect(kernel.capabilities.get(READ_ID)?.state).toBe(CapabilityState.Unloaded);
	});

	it("fails initialization when the peer capability is missing (hard dependency)", async () => {
		kernel = await bootGrepKernel([grepCapability]);

		const info = kernel.capabilities.get(GREP_ID);
		expect(info?.state).toBe(CapabilityState.Error);
		expect(info?.error).toContain("requires the read capability");
		// The resolver records the missing dependency without crashing.
		expect(kernel.capabilities.get(READ_ID)).toBeUndefined();
	});

	it("exposes the readTextFile primitive on the read capability for peer consumption", async () => {
		kernel = await bootGrepKernel();
		const dir = makeTempDir();
		const file = writeFixture(dir);

		const exports = kernel.capabilities.getExports<{ readTextFile?: (p: string) => Promise<string> }>(READ_ID);
		expect(typeof exports?.readTextFile).toBe("function");
		const text = await exports!.readTextFile!(file);
		expect(text).toContain("alpha one");
		expect(text).toContain("plain");
	});
});

describe("platform grep capability: execution", () => {
	it("searches files through the capability (fs-injected isDirectory)", async () => {
		kernel = await bootGrepKernel();
		const dir = makeTempDir();
		writeFixture(dir);
		const tool = await grepToolExport(kernel);
		const context = await grepCapabilityContext(kernel);

		const result = await tool.execute(
			{ pattern: "alpha" },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(result.success).toBe(true);
		const text = outputText(result);
		expect(text).toContain("fixture.txt:1: alpha one");
		expect(text).toContain("fixture.txt:3: alpha three");
		expect(text).not.toContain("beta two");
	});

	it("honors the execution cwd for relative search paths", async () => {
		kernel = await bootGrepKernel();
		const dir = makeTempDir();
		writeFixture(dir);
		const tool = await grepToolExport(kernel);
		const context = await grepCapabilityContext(kernel);

		const result = await tool.execute(
			{ pattern: "alpha", path: "." },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(result.success).toBe(true);
		expect(outputText(result)).toContain("fixture.txt:1: alpha one");
	});

	it("renders context lines from full file contents via the read peer", async () => {
		kernel = await bootGrepKernel();
		const dir = makeTempDir();
		const file = join(dir, "deep.txt");
		const lines = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`);
		lines[2499] = "deep target line";
		writeFileSync(file, lines.join("\n"));
		const tool = await grepToolExport(kernel);
		const context = await grepCapabilityContext(kernel);

		const result = await tool.execute(
			{ pattern: "deep target", path: file, context: 1 },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(result.success).toBe(true);
		const text = outputText(result);
		// A truncating read (the read tool's execute path, 2000 lines / 50KB)
		// would not contain the match at line 2500; only the peer readTextFile
		// full-content read can produce correct context here.
		expect(text).toContain("deep.txt-2499- line 2499");
		expect(text).toContain("deep.txt:2500: deep target line");
		expect(text).toContain("deep.txt-2501- line 2501");
	});

	it("reports errors through ToolResult (missing path, no matches)", async () => {
		kernel = await bootGrepKernel();
		const dir = makeTempDir();
		const tool = await grepToolExport(kernel);
		const context = await grepCapabilityContext(kernel);

		const missing = await tool.execute(
			{ pattern: "x", path: join(dir, "nope.txt") },
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

		const none = await tool.execute(
			{ pattern: "does-not-exist-xyz" },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(none.success).toBe(true);
		expect(outputText(none)).toContain("No matches found");
	});

	it("delegates file reads to the read capability's readTextFile export", async () => {
		const calls: string[] = [];
		const spyRead: BuiltinCapability = {
			manifest: { ...readManifest },
			factory: async () => ({
				async init() {
					return {
						tool: {
							definition: {
								name: "read",
								description: "spy read",
								parameters: {} as never,
							},
							execute: async () => ({ success: true, output: undefined }),
						} satisfies ToolCapabilityExport,
						readTextFile: async (absolutePath: string) => {
							calls.push(absolutePath);
							return readFileSync(absolutePath, "utf-8");
						},
					};
				},
				async shutdown() {},
			}),
		};
		kernel = await bootGrepKernel([spyRead, grepCapability]);
		const dir = makeTempDir();
		const file = writeFixture(dir, "spy.txt");
		const tool = await grepToolExport(kernel);
		const context = await grepCapabilityContext(kernel);

		const result = await tool.execute(
			{ pattern: "alpha", path: file, context: 1 },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(result.success).toBe(true);
		// Context-line reads went through the read peer, not the local fs.
		expect(calls).toContain(file);
	});
});

describe("platform grep search seam", () => {
	it("spawns rg through the injected ProcessService, not node:child_process", async () => {
		const recording = new RecordingProcessService();
		kernel = await bootGrepKernel([readCapability, grepCapability], recording);
		const dir = makeTempDir();
		writeFixture(dir);
		const tool = await grepToolExport(kernel);
		const context = await grepCapabilityContext(kernel);

		const result = await tool.execute(
			{ pattern: "alpha" },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(result.success).toBe(true);
		expect(outputText(result)).toContain("fixture.txt:1: alpha one");

		// The search went through the platform ProcessService: exactly one
		// spawn, the rg binary, with the JSON line-number args.
		expect(recording.spawns.length).toBe(1);
		expect(recording.spawns[0].command).toContain("rg");
		expect(recording.spawns[0].args).toContain("--json");
		expect(recording.spawns[0].args).toContain("--line-number");
		expect(recording.spawns[0].args).toContain(dir);
	});

	it("kills the rg process through the seam when the match limit is reached", async () => {
		kernel = await bootGrepKernel([readCapability, grepCapability]);
		const dir = makeTempDir();
		const file = join(dir, "many.txt");
		writeFileSync(file, Array.from({ length: 500 }, (_, i) => `line alpha ${i + 1}`).join("\n"));
		const tool = await grepToolExport(kernel);
		const context = await grepCapabilityContext(kernel);

		const result = await tool.execute(
			{ pattern: "alpha", limit: 10 },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(result.success).toBe(true);
		const text = outputText(result);
		expect(text).toContain("10 matches limit reached");
	});

	it("rejects an already-aborted signal at entry", async () => {
		kernel = await bootGrepKernel([readCapability, grepCapability]);
		const dir = makeTempDir();
		writeFixture(dir);
		const tool = await grepToolExport(kernel);
		const context = await grepCapabilityContext(kernel);
		const controller = new AbortController();
		controller.abort();

		const result = await tool.execute(
			{ pattern: "alpha" },
			{
				capability: context,
				signal: controller.signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Operation aborted");
	});
});

describe("platform runtime with read + bash + grep builtins", () => {
	it("registers all three builtins and boots them together (peer dep satisfied)", async () => {
		await ensurePlatformRuntime();
		const kernelInstance = getPlatformRuntime();
		expect(kernelInstance).toBeDefined();
		expect(kernelInstance?.capabilities.get(READ_ID)?.state).toBe(CapabilityState.Ready);
		expect(kernelInstance?.capabilities.get(BASH_ID)?.state).toBe(CapabilityState.Ready);
		expect(kernelInstance?.capabilities.get(GREP_ID)?.state).toBe(CapabilityState.Ready);
	});
});

describe("coding-agent consumption adapter", () => {
	it("returns undefined when the kernel is not booted (fallback path)", () => {
		expect(getPlatformGrepToolDefinition(process.cwd(), {})).toBeUndefined();
	});

	it("builds a working AgentSession ToolDefinition from registry exports", async () => {
		await ensurePlatformRuntime();
		const dir = makeTempDir();
		const file = writeFixture(dir);

		const definition = getPlatformGrepToolDefinition(dir, { sessionId: "test" });
		expect(definition).toBeDefined();
		expect(definition?.name).toBe("grep");
		expect(typeof definition?.renderCall).toBe("function");
		expect(typeof definition?.renderResult).toBe("function");

		const result = await definition!.execute(
			"call-1",
			{ pattern: "beta", path: file },
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);
		const text = (result.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? "").join("");
		expect(text).toContain("fixture.txt:2: beta two");
	});

	it("propagates execution errors through the definition", async () => {
		await ensurePlatformRuntime();
		const dir = makeTempDir();

		const definition = getPlatformGrepToolDefinition(dir, { sessionId: "test" });
		await expect(
			definition!.execute(
				"call-2",
				{ pattern: "x", path: join(dir, "missing.txt") },
				undefined,
				undefined,
				undefined as never,
			),
		).rejects.toThrow(/Path not found/);
	});
});
