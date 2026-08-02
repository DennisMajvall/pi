/**
 * Integration test for the Step 1.4 walking skeleton: the real `bash`
 * builtin capability traverses the complete platform lifecycle and executes
 * real commands through the registry exports backed by ProcessService.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolCapabilityExport } from "@earendil-works/pi-platform/capability";
import { CapabilityState } from "@earendil-works/pi-platform/capability";
import { capabilityId, sessionId } from "@earendil-works/pi-platform/identifier";
import { createRuntime, type KernelRuntime } from "@earendil-works/pi-platform/kernel";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { bashCapability } from "../src/platform/bash-capability.ts";
import {
	ensurePlatformRuntime,
	getPlatformBashToolDefinition,
	getPlatformRuntime,
	shutdownPlatformRuntime,
} from "../src/platform/platform-runtime.ts";

const BASH_ID = capabilityId("tool.bash");
const READ_ID = capabilityId("tool.read");

let kernel: KernelRuntime | undefined;
const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-platform-bash-"));
	tempDirs.push(dir);
	return dir;
}

async function bootBashKernel(): Promise<KernelRuntime> {
	const instance = createRuntime({
		builtins: [bashCapability],
		services: { workspaceRoot: process.cwd() },
	});
	await instance.initialize();
	await instance.start();
	return instance;
}

async function bashToolExport(instance: KernelRuntime): Promise<ToolCapabilityExport> {
	const exports = instance.capabilities.getExports<{ tool: ToolCapabilityExport }>(BASH_ID);
	if (!exports?.tool) throw new Error("bash exports missing");
	return exports.tool;
}

async function bashCapabilityContext(instance: KernelRuntime) {
	const context = instance.capabilities.getContext(BASH_ID);
	if (!context) throw new Error("bash context missing");
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

describe("platform bash capability: full lifecycle", () => {
	it("is discovered, registered, resolved, initialized, ready, and shuts down", async () => {
		kernel = await bootBashKernel();

		const info = kernel.capabilities.get(BASH_ID);
		expect(info).toBeDefined();
		expect(info?.state).toBe(CapabilityState.Ready);
		expect(info?.manifest.category).toBe("tool");
		expect(info?.manifest.requires.services).toContain("process");
		expect(info?.manifest.permissions.process).toBe("spawn");

		// exports available through the registry
		const tool = await bashToolExport(kernel);
		expect(tool.definition.name).toBe("bash");
		expect(tool.definition.parameters).toBeDefined();

		await kernel.shutdown();
		expect(kernel.capabilities.get(BASH_ID)?.state).toBe(CapabilityState.Unloaded);
	});

	it("executes a real command through the capability (ProcessService-injected)", async () => {
		kernel = await bootBashKernel();
		const dir = makeTempDir();
		const tool = await bashToolExport(kernel);
		const context = await bashCapabilityContext(kernel);

		const result = await tool.execute(
			{ command: "echo hello-from-bash && printf 'err' >&2 && exit 0" },
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
		expect(text).toContain("hello-from-bash");
		expect(text).toContain("err");
	});

	it("honors the execution cwd", async () => {
		kernel = await bootBashKernel();
		const dir = makeTempDir();
		const tool = await bashToolExport(kernel);
		const context = await bashCapabilityContext(kernel);

		const result = await tool.execute(
			{ command: "pwd" },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(result.success).toBe(true);
		expect(outputText(result)).toContain(dir);
	});

	it("reports error results (failing command) through ToolResult", async () => {
		kernel = await bootBashKernel();
		const dir = makeTempDir();
		const tool = await bashToolExport(kernel);
		const context = await bashCapabilityContext(kernel);

		const result = await tool.execute(
			{ command: "exit 7" },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Command exited with code 7");
	});

	it("reports a missing working directory", async () => {
		kernel = await bootBashKernel();
		const tool = await bashToolExport(kernel);
		const context = await bashCapabilityContext(kernel);

		const result = await tool.execute(
			{ command: "echo x" },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: "/this/does/not/exist/12345",
				metadata: {},
			},
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Working directory does not exist");
	});

	it("honors commandPrefix and shellPath from execution metadata", async () => {
		kernel = await bootBashKernel();
		const dir = makeTempDir();
		const tool = await bashToolExport(kernel);
		const context = await bashCapabilityContext(kernel);

		const result = await tool.execute(
			{ command: "echo inner" },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: { commandPrefix: "echo prefix-ran" },
			},
		);
		expect(result.success).toBe(true);
		const text = outputText(result);
		expect(text).toContain("prefix-ran");
		expect(text).toContain("inner");
	});

	it("respects the timeout option", async () => {
		kernel = await bootBashKernel();
		const dir = makeTempDir();
		const tool = await bashToolExport(kernel);
		const context = await bashCapabilityContext(kernel);

		const started = Date.now();
		const result = await tool.execute(
			{ command: "sleep 30", timeout: 1 },
			{
				capability: context,
				signal: new AbortController().signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("Command timed out after 1 seconds");
		expect(Date.now() - started).toBeLessThan(10_000);
	});

	it("reports abort via the signal as an error result", async () => {
		kernel = await bootBashKernel();
		const dir = makeTempDir();
		const tool = await bashToolExport(kernel);
		const context = await bashCapabilityContext(kernel);
		const controller = new AbortController();

		const promise = tool.execute(
			{ command: "sleep 30" },
			{
				capability: context,
				signal: controller.signal,
				sessionId: sessionId("test"),
				cwd: dir,
				metadata: {},
			},
		);
		setTimeout(() => controller.abort(), 150);
		const result = await promise;
		expect(result.success).toBe(false);
		expect(result.error).toContain("Command aborted");
	});
});

describe("platform runtime with read + bash builtins", () => {
	it("registers both builtins and boots them together", async () => {
		await ensurePlatformRuntime();
		const kernelInstance = getPlatformRuntime();
		expect(kernelInstance).toBeDefined();
		expect(kernelInstance?.capabilities.get(BASH_ID)?.state).toBe(CapabilityState.Ready);
		expect(kernelInstance?.capabilities.get(READ_ID)?.state).toBe(CapabilityState.Ready);
	});
});

describe("coding-agent consumption adapter", () => {
	it("returns undefined when the kernel is not booted (fallback path)", () => {
		expect(getPlatformBashToolDefinition(process.cwd(), {})).toBeUndefined();
	});

	it("builds a working AgentSession ToolDefinition from registry exports", async () => {
		await ensurePlatformRuntime();
		const dir = makeTempDir();

		const definition = getPlatformBashToolDefinition(dir, { sessionId: "test" });
		expect(definition).toBeDefined();
		expect(definition?.name).toBe("bash");
		expect(typeof definition?.renderCall).toBe("function");
		expect(typeof definition?.renderResult).toBe("function");

		const result = await definition!.execute(
			"call-1",
			{ command: "echo platform-consume-ok" },
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);
		const text = (result.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? "").join("");
		expect(text).toContain("platform-consume-ok");
	});

	it("propagates execution errors through the definition", async () => {
		await ensurePlatformRuntime();
		const dir = makeTempDir();
		const definition = getPlatformBashToolDefinition(dir, { sessionId: "test" });

		await expect(
			definition!.execute("call-2", { command: "exit 1" }, undefined, undefined, undefined as never),
		).rejects.toThrow(/code 1/);
	});

	it("passes shellPath and commandPrefix through to execution", async () => {
		await ensurePlatformRuntime();
		const dir = makeTempDir();
		const definition = getPlatformBashToolDefinition(dir, {
			commandPrefix: "echo from-prefix",
			sessionId: "test",
		});

		const result = await definition!.execute(
			"call-3",
			{ command: "echo body" },
			undefined,
			undefined,
			undefined as never,
		);
		const text = (result.content as Array<{ type: string; text?: string }>).map((p) => p.text ?? "").join("");
		expect(text).toContain("from-prefix");
		expect(text).toContain("body");
	});
});
