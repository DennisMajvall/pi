/**
 * Coding-agent platform runtime wiring.
 *
 * Boots the walking-skeleton kernel as a process-level singleton with the
 * read, bash, grep, find, ls, write, and edit builtin capabilities, and
 * adapts their exports into the coding-agent tool definitions used by
 * AgentSession.
 *
 * Step 1.10 gate: the platform is the DEFAULT execution path for the builtin
 * tools. `getPlatformAllToolDefinitions` returns the full seven-tool set when
 * the kernel is booted and every tool export is available, and `_buildRuntime`
 * consumes that set atomically through `resolveBaseToolDefinitions` — all
 * seven tools come from the platform, or all seven fall back to the legacy
 * definitions. No mixed platform/legacy session state is possible.
 *
 * Failure-safe: if the kernel cannot start (or a tool export is missing), the
 * set is undefined and AgentSession falls back to the legacy paths wholesale,
 * with a warning — a kernel failure never fails a session.
 */

import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { CapabilityContext, ToolCapabilityExport } from "@earendil-works/pi-platform/capability";
import { type CapabilityId, capabilityId, sessionId } from "@earendil-works/pi-platform/identifier";
import { createRuntime, type KernelRuntime } from "@earendil-works/pi-platform/kernel";
import chalk from "chalk";
import type { ExtensionContext, ToolDefinition } from "../core/extensions/types.ts";
import { SessionManager } from "../core/session-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { createBashToolDefinition } from "../core/tools/bash.ts";
import { createEditToolDefinition } from "../core/tools/edit.ts";
import { createFindToolDefinition } from "../core/tools/find.ts";
import { createGrepToolDefinition } from "../core/tools/grep.ts";
import type { ToolDef, ToolName } from "../core/tools/index.ts";
import { createLsToolDefinition } from "../core/tools/ls.ts";
import { createReadToolDefinition } from "../core/tools/read.ts";
import { createWriteToolDefinition } from "../core/tools/write.ts";
import { bashCapability } from "./bash-capability.ts";
import { editCapability } from "./edit-capability.ts";
import { findCapability } from "./find-capability.ts";
import { grepCapability } from "./grep-capability.ts";
import { lsCapability } from "./ls-capability.ts";
import { readCapability } from "./read-capability.ts";
import { SessionManagerService } from "./session-service.ts";
import { SettingsManagerService } from "./settings-service.ts";
import { writeCapability } from "./write-capability.ts";

const READ_CAPABILITY_ID = capabilityId("tool.read");
const BASH_CAPABILITY_ID = capabilityId("tool.bash");
const GREP_CAPABILITY_ID = capabilityId("tool.grep");
const FIND_CAPABILITY_ID = capabilityId("tool.find");
const LS_CAPABILITY_ID = capabilityId("tool.ls");
const WRITE_CAPABILITY_ID = capabilityId("tool.write");
const EDIT_CAPABILITY_ID = capabilityId("tool.edit");

let runtime: KernelRuntime | undefined;
let bootPromise: Promise<KernelRuntime | undefined> | undefined;

/**
 * Boot the platform runtime once per process. Idempotent; failure-safe.
 * The optional settingsManager backs the injected SettingsService and the
 * optional sessionManager backs the injected SessionService; when omitted
 * (tests, callers without a manager) in-memory managers are used.
 */
export async function ensurePlatformRuntime(options: PlatformRuntimeOptions = {}): Promise<KernelRuntime | undefined> {
	if (runtime) return runtime;
	if (!bootPromise) {
		bootPromise = bootPlatformRuntime(options);
	}
	return bootPromise;
}

export interface PlatformRuntimeOptions {
	settingsManager?: SettingsManager;
	sessionManager?: SessionManager;
}

async function bootPlatformRuntime(options: PlatformRuntimeOptions): Promise<KernelRuntime | undefined> {
	try {
		const settings = new SettingsManagerService(options.settingsManager ?? SettingsManager.inMemory());
		const session = new SessionManagerService(options.sessionManager ?? SessionManager.inMemory());
		const kernel = createRuntime({
			builtins: [
				readCapability,
				bashCapability,
				grepCapability,
				findCapability,
				lsCapability,
				writeCapability,
				editCapability,
			],
			services: { workspaceRoot: process.cwd(), settings, session },
		});
		await kernel.initialize();
		await kernel.start();
		runtime = kernel;
		return kernel;
	} catch (error) {
		console.error(
			chalk.yellow(
				`[platform] runtime failed to start; falling back to legacy paths: ${error instanceof Error ? error.message : String(error)}`,
			),
		);
		runtime = undefined;
		return undefined;
	}
}

/** Synchronous accessor for the booted runtime (used by _buildRuntime). */
export function getPlatformRuntime(): KernelRuntime | undefined {
	return runtime;
}

/** Shut the platform runtime down (tests / process teardown). */
export async function shutdownPlatformRuntime(): Promise<void> {
	if (runtime) {
		await runtime.shutdown();
	}
	runtime = undefined;
	bootPromise = undefined;
}

export interface PlatformToolSetOptions {
	sessionId?: string;
}

/**
 * Per-tool adapter spec: the only per-tool variation left after the Step 1.10
 * dedup. One template per tool supplies the renderers (all seven define
 * renderCall/renderResult as object members) and, for edit, the
 * prepareArguments compatibility shim and `renderShell: "self"` framing.
 */
interface PlatformToolSpec {
	readonly capabilityId: CapabilityId;
	readonly label: string;
	readonly toolName: ToolName;
	readonly template: ToolDefinition<any, any>;
	/** Execution metadata: read passes { model }, bash passes { extensionContext, onUpdate }, the rest {} */
	readonly metadata: (
		extensionContext: ExtensionContext | undefined,
		onUpdate: AgentToolUpdateCallback | undefined,
	) => Record<string, unknown>;
	readonly extras?: Pick<ToolDefinition, "prepareArguments" | "renderShell">;
}

const editToolTemplate = createEditToolDefinition("");

const PLATFORM_TOOL_SPECS: PlatformToolSpec[] = [
	{
		capabilityId: READ_CAPABILITY_ID,
		label: "read",
		toolName: "read",
		template: createReadToolDefinition(""),
		metadata: (extensionContext) => ({ model: extensionContext?.model }),
	},
	{
		capabilityId: BASH_CAPABILITY_ID,
		label: "bash",
		toolName: "bash",
		template: createBashToolDefinition(""),
		// The real ExtensionContext + onUpdate ride through metadata so the
		// re-entered definition keeps session env (PI_*) and live updates.
		metadata: (extensionContext, onUpdate) => ({ extensionContext, onUpdate }),
	},
	{
		capabilityId: GREP_CAPABILITY_ID,
		label: "grep",
		toolName: "grep",
		template: createGrepToolDefinition(""),
		metadata: () => ({}),
	},
	{
		capabilityId: FIND_CAPABILITY_ID,
		label: "find",
		toolName: "find",
		template: createFindToolDefinition(""),
		metadata: () => ({}),
	},
	{
		capabilityId: LS_CAPABILITY_ID,
		label: "ls",
		toolName: "ls",
		template: createLsToolDefinition(""),
		metadata: () => ({}),
	},
	{
		capabilityId: WRITE_CAPABILITY_ID,
		label: "write",
		toolName: "write",
		template: createWriteToolDefinition(""),
		metadata: () => ({}),
	},
	{
		capabilityId: EDIT_CAPABILITY_ID,
		label: "edit",
		toolName: "edit",
		template: editToolTemplate,
		metadata: () => ({}),
		extras: { prepareArguments: editToolTemplate.prepareArguments, renderShell: editToolTemplate.renderShell },
	},
];

/**
 * Build one AgentSession ToolDefinition from a platform registry export.
 *
 * The adapter boundary sits between two contract systems (platform tool export
 * and coding-agent ToolDefinition); ToolDefinition<any, any> mirrors the
 * existing wrapper.ts boundary typing, and the result detail type is `any`
 * for the same reason — the per-tool detail types of the seven original
 * builders were already erased by that boundary type.
 */
function buildPlatformToolDefinition(
	spec: PlatformToolSpec,
	tool: ToolCapabilityExport,
	context: CapabilityContext,
	cwd: string,
	options: PlatformToolSetOptions,
): ToolDefinition<any, any> {
	return {
		name: tool.definition.name,
		label: spec.label,
		description: tool.definition.description,
		promptSnippet: tool.definition.promptSnippet,
		promptGuidelines: tool.definition.promptGuidelines,
		parameters: tool.definition.parameters,
		prepareArguments: spec.extras?.prepareArguments,
		renderShell: spec.extras?.renderShell,
		execute: async (_toolCallId, params, signal, onUpdate, extensionContext) => {
			const result = await tool.execute(params, {
				capability: context,
				signal: signal ?? new AbortController().signal,
				sessionId: sessionId(options.sessionId ?? "unknown"),
				cwd,
				metadata: spec.metadata(extensionContext, onUpdate),
			});
			if (!result.success) {
				throw new Error(result.error ?? `${spec.label} failed`);
			}
			return result.output as unknown as AgentToolResult<any>;
		},
		renderCall: spec.template.renderCall as unknown as ToolDefinition<any, any>["renderCall"],
		renderResult: spec.template.renderResult as unknown as ToolDefinition<any, any>["renderResult"],
	};
}

/** Shared single-tool lookup used by the granular accessors below. */
function buildPlatformToolByName(
	kernel: KernelRuntime,
	toolName: ToolName,
	cwd: string,
	options: PlatformToolSetOptions,
): ToolDefinition | undefined {
	const spec = PLATFORM_TOOL_SPECS.find((entry) => entry.toolName === toolName);
	if (!spec) return undefined;
	const tool = kernel.capabilities.getExports<{ tool: ToolCapabilityExport }>(spec.capabilityId)?.tool;
	const context = kernel.capabilities.getContext(spec.capabilityId);
	if (!tool || !context) return undefined;
	return buildPlatformToolDefinition(spec, tool, context, cwd, options);
}

/**
 * Build the full builtin tool set from a kernel. Atomic: returns the complete
 * `Record<ToolName, ToolDef>` when the kernel is booted and every one of the
 * seven tool exports is available; undefined otherwise (kernel unavailable, or
 * a capability init failure left a tool export missing). Kernel-parametrized
 * so tests can exercise the atomicity without touching the process singleton.
 */
export function buildAllToolDefinitionsFromKernel(
	kernel: KernelRuntime | undefined,
	cwd: string,
	options: PlatformToolSetOptions = {},
): Record<ToolName, ToolDef> | undefined {
	if (!kernel) return undefined;
	const definitions: Partial<Record<ToolName, ToolDef>> = {};
	for (const spec of PLATFORM_TOOL_SPECS) {
		const tool = kernel.capabilities.getExports<{ tool: ToolCapabilityExport }>(spec.capabilityId)?.tool;
		const context = kernel.capabilities.getContext(spec.capabilityId);
		if (!tool || !context) {
			// Partial registry: the kernel is up but a tool export is missing.
			// The platform tool set is atomic — fall the whole set back to
			// legacy, loudly, so a silently-degraded half-platform session
			// cannot happen.
			console.warn(chalk.yellow(`[platform] tool "${spec.label}" unavailable; falling back to legacy paths`));
			return undefined;
		}
		definitions[spec.toolName] = buildPlatformToolDefinition(spec, tool, context, cwd, options);
	}
	return definitions as Record<ToolName, ToolDef>;
}

/**
 * The Step 1.10 gate decision for the booted process singleton: the full
 * platform tool set, or undefined (fall back to legacy).
 */
export function getPlatformAllToolDefinitions(
	cwd: string,
	options: PlatformToolSetOptions = {},
): Record<ToolName, ToolDef> | undefined {
	return buildAllToolDefinitionsFromKernel(getPlatformRuntime(), cwd, options);
}

/**
 * Resolve the base tool set for an AgentSession: platform-first, legacy as the
 * explicit fallback. The `??` is the whole gate — the platform tool set is
 * atomic, so `_buildRuntime` can never produce a mixed platform/legacy set.
 */
export function resolveBaseToolDefinitions(
	cwd: string,
	options: PlatformToolSetOptions,
	buildLegacy: (cwd: string) => Record<ToolName, ToolDef>,
): Record<ToolName, ToolDef> {
	return getPlatformAllToolDefinitions(cwd, options) ?? buildLegacy(cwd);
}

/**
 * Granular accessors (used by tests and hosts that need one tool). The
 * session itself consumes the atomic set via `getPlatformAllToolDefinitions` /
 * `resolveBaseToolDefinitions`; each of these returns undefined when the
 * kernel is not available, in which case callers fall back to the legacy
 * definition.
 */
export function getPlatformReadToolDefinition(
	cwd: string,
	options: PlatformToolSetOptions = {},
): ToolDefinition | undefined {
	const kernel = getPlatformRuntime();
	if (!kernel) return undefined;
	return buildPlatformToolByName(kernel, "read", cwd, options);
}

export function getPlatformBashToolDefinition(
	cwd: string,
	options: PlatformToolSetOptions = {},
): ToolDefinition | undefined {
	const kernel = getPlatformRuntime();
	if (!kernel) return undefined;
	return buildPlatformToolByName(kernel, "bash", cwd, options);
}

export function getPlatformGrepToolDefinition(
	cwd: string,
	options: PlatformToolSetOptions = {},
): ToolDefinition | undefined {
	const kernel = getPlatformRuntime();
	if (!kernel) return undefined;
	return buildPlatformToolByName(kernel, "grep", cwd, options);
}

export function getPlatformFindToolDefinition(
	cwd: string,
	options: PlatformToolSetOptions = {},
): ToolDefinition | undefined {
	const kernel = getPlatformRuntime();
	if (!kernel) return undefined;
	return buildPlatformToolByName(kernel, "find", cwd, options);
}

export function getPlatformLsToolDefinition(
	cwd: string,
	options: PlatformToolSetOptions = {},
): ToolDefinition | undefined {
	const kernel = getPlatformRuntime();
	if (!kernel) return undefined;
	return buildPlatformToolByName(kernel, "ls", cwd, options);
}

export function getPlatformWriteToolDefinition(
	cwd: string,
	options: PlatformToolSetOptions = {},
): ToolDefinition | undefined {
	const kernel = getPlatformRuntime();
	if (!kernel) return undefined;
	return buildPlatformToolByName(kernel, "write", cwd, options);
}

export function getPlatformEditToolDefinition(
	cwd: string,
	options: PlatformToolSetOptions = {},
): ToolDefinition | undefined {
	const kernel = getPlatformRuntime();
	if (!kernel) return undefined;
	return buildPlatformToolByName(kernel, "edit", cwd, options);
}
