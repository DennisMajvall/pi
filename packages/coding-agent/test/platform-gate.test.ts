/**
 * Integration test for the Step 1.10 gate: the platform is the default
 * execution path for all builtin tools, not a silent fallback.
 *
 * Covers the atomic platform tool set (all seven or none), the platform-first
 * vs legacy resolution decision `_buildRuntime` consumes, the manifest-to-
 * template description coupling fixture, and a session-level smoke of a
 * platform-backed tool through the agent loop.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import type { CapabilityManifest } from "@earendil-works/pi-platform/capability";
import { type BuiltinCapability, createRuntime, type KernelRuntime } from "@earendil-works/pi-platform/kernel";
import { afterEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createAllToolDefinitions, type ToolName } from "../src/core/tools/index.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { bashCapability, bashManifest } from "../src/platform/bash-capability.ts";
import { editCapability, editManifest } from "../src/platform/edit-capability.ts";
import { findCapability, findManifest } from "../src/platform/find-capability.ts";
import { grepCapability, grepManifest } from "../src/platform/grep-capability.ts";
import { lsCapability, lsManifest } from "../src/platform/ls-capability.ts";
import {
	buildAllToolDefinitionsFromKernel,
	ensurePlatformRuntime,
	getPlatformAllToolDefinitions,
	getPlatformRuntime,
	resolveBaseToolDefinitions,
	shutdownPlatformRuntime,
} from "../src/platform/platform-runtime.ts";
import { readCapability, readManifest } from "../src/platform/read-capability.ts";
import { writeCapability, writeManifest } from "../src/platform/write-capability.ts";
import { createHarness, type Harness } from "./test-harness.ts";

const ALL_BUILTINS: BuiltinCapability[] = [
	readCapability,
	bashCapability,
	grepCapability,
	findCapability,
	lsCapability,
	writeCapability,
	editCapability,
];

const ALL_TOOL_NAMES: ToolName[] = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const ALL_TOOL_NAMES_SORTED = [...ALL_TOOL_NAMES].sort();

const MANIFEST_TEMPLATE_PAIRS: Array<{
	toolName: ToolName;
	manifest: CapabilityManifest;
	template: ToolDefinition<any, any>;
}> = [
	{ toolName: "read", manifest: readManifest, template: createReadToolDefinition("") },
	{ toolName: "bash", manifest: bashManifest, template: createBashToolDefinition("") },
	{ toolName: "grep", manifest: grepManifest, template: createGrepToolDefinition("") },
	{ toolName: "find", manifest: findManifest, template: createFindToolDefinition("") },
	{ toolName: "ls", manifest: lsManifest, template: createLsToolDefinition("") },
	{ toolName: "write", manifest: writeManifest, template: createWriteToolDefinition("") },
	{ toolName: "edit", manifest: editManifest, template: createEditToolDefinition("") },
];

const kernels: KernelRuntime[] = [];
const tempDirs: string[] = [];
const harnesses: Harness[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-platform-gate-"));
	tempDirs.push(dir);
	return dir;
}

async function bootKernel(builtins: BuiltinCapability[]): Promise<KernelRuntime> {
	const kernel = createRuntime({ builtins, services: { workspaceRoot: process.cwd() } });
	await kernel.initialize();
	await kernel.start();
	kernels.push(kernel);
	return kernel;
}

afterEach(async () => {
	await shutdownPlatformRuntime();
	for (const kernel of kernels) {
		await kernel.shutdown();
	}
	kernels.length = 0;
	for (const harness of harnesses) {
		harness.cleanup();
	}
	harnesses.length = 0;
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

describe("atomic platform tool set (gate)", () => {
	it("builds all seven definitions when the kernel is fully booted", async () => {
		const kernel = await bootKernel(ALL_BUILTINS);
		const cwd = makeTempDir();

		const definitions = buildAllToolDefinitionsFromKernel(kernel, cwd, { sessionId: "test" });
		expect(definitions).toBeDefined();
		expect(Object.keys(definitions!).sort()).toEqual(ALL_TOOL_NAMES_SORTED);
		for (const name of ALL_TOOL_NAMES) {
			const definition = definitions![name];
			expect(definition.name).toBe(name);
			expect(typeof definition.renderCall).toBe("function");
			expect(typeof definition.renderResult).toBe("function");
		}
		// edit carries the template's compatibility shim + self-shell framing.
		expect(typeof definitions!.edit.prepareArguments).toBe("function");
		expect(definitions!.edit.renderShell).toBe("self");
	});

	it("returns undefined when a tool export is missing (partial registry, no mixed state)", async () => {
		// The full builtin set minus edit: the kernel boots, but the atomic
		// gate must refuse a partial platform set.
		const kernel = await bootKernel([
			readCapability,
			bashCapability,
			grepCapability,
			findCapability,
			lsCapability,
			writeCapability,
		]);
		const cwd = makeTempDir();

		expect(buildAllToolDefinitionsFromKernel(kernel, cwd)).toBeUndefined();
	});

	it("returns undefined when the kernel is not booted", () => {
		const cwd = makeTempDir();

		expect(buildAllToolDefinitionsFromKernel(undefined, cwd)).toBeUndefined();
	});

	it("follows the process singleton: all seven after boot, undefined after shutdown", async () => {
		const cwd = makeTempDir();
		await ensurePlatformRuntime();

		const definitions = getPlatformAllToolDefinitions(cwd);
		expect(definitions).toBeDefined();
		expect(Object.keys(definitions!).sort()).toEqual(ALL_TOOL_NAMES_SORTED);

		await shutdownPlatformRuntime();
		expect(getPlatformAllToolDefinitions(cwd)).toBeUndefined();
	});
});

describe("resolveBaseToolDefinitions (platform-first, legacy fallback)", () => {
	it("prefers the platform definitions when the kernel is booted", async () => {
		const cwd = makeTempDir();
		await ensurePlatformRuntime();
		const legacy = createAllToolDefinitions(cwd, {});

		const definitions = resolveBaseToolDefinitions(cwd, { sessionId: "test" }, () => legacy);
		expect(Object.keys(definitions).sort()).toEqual(ALL_TOOL_NAMES_SORTED);
		// Platform-built objects are not the legacy ones: _buildRuntime consumes
		// the platform set wholesale when the kernel is booted.
		expect(definitions.read).not.toBe(legacy.read);
		expect(definitions.edit).not.toBe(legacy.edit);
	});

	it("falls back to the exact legacy definitions when the kernel is not booted", () => {
		const cwd = makeTempDir();
		const legacy = createAllToolDefinitions(cwd, {});

		const definitions = resolveBaseToolDefinitions(cwd, {}, () => legacy);
		expect(Object.keys(definitions).sort()).toEqual(ALL_TOOL_NAMES_SORTED);
		// Identity: the fallback returns the very legacy objects (wholesale,
		// not rebuilt), proving there is no mixed platform/legacy state.
		expect(definitions.read).toBe(legacy.read);
		expect(definitions.edit).toBe(legacy.edit);
	});
});

describe("manifest-to-template description coupling", () => {
	for (const { toolName, manifest, template } of MANIFEST_TEMPLATE_PAIRS) {
		it(`pins ${toolName}'s manifest provides.tool prose to the tool template`, () => {
			const declared = manifest.provides.tool;
			expect(declared?.name).toBe(template.name);
			expect(declared?.description).toBe(template.description);
			expect(declared?.parameters).toBe(template.parameters);
			expect(declared?.promptSnippet).toBe(template.promptSnippet);
			expect(declared?.promptGuidelines).toEqual(template.promptGuidelines);
		});
	}
});

describe("session integration (platform-backed tools through the agent loop)", () => {
	it("executes a read through the platform set when the kernel is booted", async () => {
		await ensurePlatformRuntime();
		expect(getPlatformRuntime()).toBeDefined();

		const harness = await createHarness({
			responses: [{ toolCalls: [{ name: "read", args: { path: "fixture.txt" } }] }, "done"],
		});
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "fixture.txt"), "gate line one\ngate line two\n");

		await harness.session.prompt("read the file");

		const toolResult = harness.session.messages.find((message) => message.role === "toolResult");
		expect(toolResult).toBeDefined();
		const text = toolResult!.content
			.filter((part): part is TextContent => part.type === "text")
			.map((part) => part.text)
			.join("");
		expect(text).toContain("gate line one");
		expect(text).toContain("gate line two");
	});
});
