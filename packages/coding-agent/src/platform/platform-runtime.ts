/**
 * Coding-agent platform runtime wiring.
 *
 * Boots the walking-skeleton kernel as a process-level singleton with the
 * read, bash, grep, find, and ls pilot capabilities, and adapts their exports
 * into the coding-agent tool definitions used by AgentSession.
 *
 * Failure-safe: if the kernel cannot start,
 * `getPlatformReadToolDefinition` / `getPlatformBashToolDefinition` /
 * `getPlatformGrepToolDefinition` / `getPlatformFindToolDefinition` /
 * `getPlatformLsToolDefinition` return undefined and AgentSession falls back
 * to the legacy paths, so existing behaviour never changes.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { CapabilityContext, ToolCapabilityExport } from "@earendil-works/pi-platform/capability";
import { capabilityId, sessionId } from "@earendil-works/pi-platform/identifier";
import { createRuntime, type KernelRuntime } from "@earendil-works/pi-platform/kernel";
import chalk from "chalk";
import type { ToolDefinition, ToolRenderContext } from "../core/extensions/types.ts";
import { SessionManager } from "../core/session-manager.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import type { BashToolDetails, BashToolInput } from "../core/tools/bash.ts";
import { createBashToolDefinition } from "../core/tools/bash.ts";
import type { FindToolDetails, FindToolInput } from "../core/tools/find.ts";
import { createFindToolDefinition } from "../core/tools/find.ts";
import type { GrepToolDetails, GrepToolInput } from "../core/tools/grep.ts";
import { createGrepToolDefinition } from "../core/tools/grep.ts";
import type { LsToolDetails, LsToolInput } from "../core/tools/ls.ts";
import { createLsToolDefinition } from "../core/tools/ls.ts";
import type { ReadRenderArgs } from "../core/tools/read.ts";
import { type ReadToolDetails, type ReadToolInput, renderReadCall, renderReadResult } from "../core/tools/read.ts";
import { bashCapability } from "./bash-capability.ts";
import { findCapability } from "./find-capability.ts";
import { grepCapability } from "./grep-capability.ts";
import { lsCapability } from "./ls-capability.ts";
import { readCapability } from "./read-capability.ts";
import { SessionManagerService } from "./session-service.ts";
import { SettingsManagerService } from "./settings-service.ts";

const READ_CAPABILITY_ID = capabilityId("tool.read");
const BASH_CAPABILITY_ID = capabilityId("tool.bash");
const GREP_CAPABILITY_ID = capabilityId("tool.grep");
const FIND_CAPABILITY_ID = capabilityId("tool.find");
const LS_CAPABILITY_ID = capabilityId("tool.ls");

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
			builtins: [readCapability, bashCapability, grepCapability, findCapability, lsCapability],
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

export interface PlatformReadOptions {
	sessionId?: string;
}

/**
 * Build the AgentSession read ToolDefinition from the platform registry
 * exports. Returns undefined when the kernel is not available, in which case
 * callers fall back to the legacy definition.
 */
export function getPlatformReadToolDefinition(
	cwd: string,
	options: PlatformReadOptions = {},
): ToolDefinition | undefined {
	const kernel = getPlatformRuntime();
	if (!kernel) return undefined;
	const tool = kernel.capabilities.getExports<{ tool: ToolCapabilityExport }>(READ_CAPABILITY_ID)?.tool;
	const context = kernel.capabilities.getContext(READ_CAPABILITY_ID);
	if (!tool || !context) return undefined;
	return buildReadToolDefinition(tool, context, cwd, options);
}

export interface PlatformBashOptions {
	sessionId?: string;
}

/**
 * Build the AgentSession bash ToolDefinition from the platform registry
 * exports. Returns undefined when the kernel is not available, in which case
 * callers fall back to the legacy definition.
 */
export function getPlatformBashToolDefinition(
	cwd: string,
	options: PlatformBashOptions = {},
): ToolDefinition | undefined {
	const kernel = getPlatformRuntime();
	if (!kernel) return undefined;
	const tool = kernel.capabilities.getExports<{ tool: ToolCapabilityExport }>(BASH_CAPABILITY_ID)?.tool;
	const context = kernel.capabilities.getContext(BASH_CAPABILITY_ID);
	if (!tool || !context) return undefined;
	return buildBashToolDefinition(tool, context, cwd, options);
}

export interface PlatformGrepOptions {
	sessionId?: string;
}

/**
 * Build the AgentSession grep ToolDefinition from the platform registry
 * exports. Returns undefined when the kernel is not available, in which case
 * callers fall back to the legacy definition.
 */
export function getPlatformGrepToolDefinition(
	cwd: string,
	options: PlatformGrepOptions = {},
): ToolDefinition | undefined {
	const kernel = getPlatformRuntime();
	if (!kernel) return undefined;
	const tool = kernel.capabilities.getExports<{ tool: ToolCapabilityExport }>(GREP_CAPABILITY_ID)?.tool;
	const context = kernel.capabilities.getContext(GREP_CAPABILITY_ID);
	if (!tool || !context) return undefined;
	return buildGrepToolDefinition(tool, context, cwd, options);
}

export interface PlatformFindOptions {
	sessionId?: string;
}

/**
 * Build the AgentSession find ToolDefinition from the platform registry
 * exports. Returns undefined when the kernel is not available, in which case
 * callers fall back to the legacy definition.
 */
export function getPlatformFindToolDefinition(
	cwd: string,
	options: PlatformFindOptions = {},
): ToolDefinition | undefined {
	const kernel = getPlatformRuntime();
	if (!kernel) return undefined;
	const tool = kernel.capabilities.getExports<{ tool: ToolCapabilityExport }>(FIND_CAPABILITY_ID)?.tool;
	const context = kernel.capabilities.getContext(FIND_CAPABILITY_ID);
	if (!tool || !context) return undefined;
	return buildFindToolDefinition(tool, context, cwd, options);
}

export interface PlatformLsOptions {
	sessionId?: string;
}

/**
 * Build the AgentSession ls ToolDefinition from the platform registry
 * exports. Returns undefined when the kernel is not available, in which case
 * callers fall back to the legacy definition.
 */
export function getPlatformLsToolDefinition(cwd: string, options: PlatformLsOptions = {}): ToolDefinition | undefined {
	const kernel = getPlatformRuntime();
	if (!kernel) return undefined;
	const tool = kernel.capabilities.getExports<{ tool: ToolCapabilityExport }>(LS_CAPABILITY_ID)?.tool;
	const context = kernel.capabilities.getContext(LS_CAPABILITY_ID);
	if (!tool || !context) return undefined;
	return buildLsToolDefinition(tool, context, cwd, options);
}

// The adapter boundary sits between two contract systems (platform tool export
// and coding-agent ToolDefinition); ToolDefinition<any, any> mirrors the
// existing wrapper.ts boundary typing.
function buildReadToolDefinition(
	tool: ToolCapabilityExport,
	context: CapabilityContext,
	cwd: string,
	options: PlatformReadOptions,
): ToolDefinition<any, any> {
	return {
		name: tool.definition.name,
		label: "read",
		description: tool.definition.description,
		promptSnippet: tool.definition.promptSnippet,
		promptGuidelines: tool.definition.promptGuidelines,
		parameters: tool.definition.parameters,
		execute: async (_toolCallId, params, signal, _onUpdate, extCtx) => {
			const result = await tool.execute(params as ReadToolInput, {
				capability: context,
				signal: signal ?? new AbortController().signal,
				sessionId: sessionId(options.sessionId ?? "unknown"),
				cwd,
				metadata: {
					model: extCtx?.model,
				},
			});
			if (!result.success) {
				throw new Error(result.error ?? "read failed");
			}
			return result.output as unknown as AgentToolResult<ReadToolDetails | undefined>;
		},
		renderCall: (args, theme, renderContext) =>
			renderReadCall(
				args as ReadRenderArgs | undefined,
				theme,
				renderContext as ToolRenderContext<unknown, ReadRenderArgs | undefined>,
			),
		renderResult: (result, renderOptions, theme, renderContext) =>
			renderReadResult(
				result as never,
				renderOptions,
				theme,
				renderContext as ToolRenderContext<unknown, ReadRenderArgs | undefined>,
			),
	};
}

// The bash tool's renderers are object methods on the definition (never
// extracted as module functions like read's); a template definition supplies
// them to the platform-built definition without touching bash.ts.
function buildBashToolDefinition(
	tool: ToolCapabilityExport,
	context: CapabilityContext,
	cwd: string,
	options: PlatformBashOptions,
): ToolDefinition<any, any> {
	const template = createBashToolDefinition("");
	return {
		name: tool.definition.name,
		label: "bash",
		description: tool.definition.description,
		promptSnippet: tool.definition.promptSnippet,
		promptGuidelines: tool.definition.promptGuidelines,
		parameters: tool.definition.parameters,
		execute: async (_toolCallId, params, signal, onUpdate, extCtx) => {
			const result = await tool.execute(params as BashToolInput, {
				capability: context,
				signal: signal ?? new AbortController().signal,
				sessionId: sessionId(options.sessionId ?? "unknown"),
				cwd,
				metadata: {
					// The real ExtensionContext + onUpdate ride through metadata so the
					// re-entered definition keeps session env (PI_*) and live updates.
					extensionContext: extCtx,
					onUpdate,
				},
			});
			if (!result.success) {
				throw new Error(result.error ?? "bash failed");
			}
			return result.output as unknown as AgentToolResult<BashToolDetails | undefined>;
		},
		renderCall: template.renderCall as unknown as ToolDefinition<any, any>["renderCall"],
		renderResult: template.renderResult as unknown as ToolDefinition<any, any>["renderResult"],
	};
}

// The grep tool's renderers are object methods on the definition (never
// extracted as module functions like read's); a template definition supplies
// them to the platform-built definition without touching grep.ts.
function buildGrepToolDefinition(
	tool: ToolCapabilityExport,
	context: CapabilityContext,
	cwd: string,
	options: PlatformGrepOptions,
): ToolDefinition<any, any> {
	const template = createGrepToolDefinition("");
	return {
		name: tool.definition.name,
		label: "grep",
		description: tool.definition.description,
		promptSnippet: tool.definition.promptSnippet,
		promptGuidelines: tool.definition.promptGuidelines,
		parameters: tool.definition.parameters,
		execute: async (_toolCallId, params, signal, _onUpdate, _extCtx) => {
			const result = await tool.execute(params as GrepToolInput, {
				capability: context,
				signal: signal ?? new AbortController().signal,
				sessionId: sessionId(options.sessionId ?? "unknown"),
				cwd,
				metadata: {},
			});
			if (!result.success) {
				throw new Error(result.error ?? "grep failed");
			}
			return result.output as unknown as AgentToolResult<GrepToolDetails | undefined>;
		},
		renderCall: template.renderCall as unknown as ToolDefinition<any, any>["renderCall"],
		renderResult: template.renderResult as unknown as ToolDefinition<any, any>["renderResult"],
	};
}

// The find tool's renderers are object methods on the definition (never
// extracted as module functions like read's); a template definition supplies
// them to the platform-built definition without touching find.ts.
function buildFindToolDefinition(
	tool: ToolCapabilityExport,
	context: CapabilityContext,
	cwd: string,
	options: PlatformFindOptions,
): ToolDefinition<any, any> {
	const template = createFindToolDefinition("");
	return {
		name: tool.definition.name,
		label: "find",
		description: tool.definition.description,
		promptSnippet: tool.definition.promptSnippet,
		promptGuidelines: tool.definition.promptGuidelines,
		parameters: tool.definition.parameters,
		execute: async (_toolCallId, params, signal, _onUpdate, _extCtx) => {
			const result = await tool.execute(params as FindToolInput, {
				capability: context,
				signal: signal ?? new AbortController().signal,
				sessionId: sessionId(options.sessionId ?? "unknown"),
				cwd,
				metadata: {},
			});
			if (!result.success) {
				throw new Error(result.error ?? "find failed");
			}
			return result.output as unknown as AgentToolResult<FindToolDetails | undefined>;
		},
		renderCall: template.renderCall as unknown as ToolDefinition<any, any>["renderCall"],
		renderResult: template.renderResult as unknown as ToolDefinition<any, any>["renderResult"],
	};
}

// The ls tool's renderers are object methods on the definition (never
// extracted as module functions like read's); a template definition supplies
// them to the platform-built definition without touching ls.ts.
function buildLsToolDefinition(
	tool: ToolCapabilityExport,
	context: CapabilityContext,
	cwd: string,
	options: PlatformLsOptions,
): ToolDefinition<any, any> {
	const template = createLsToolDefinition("");
	return {
		name: tool.definition.name,
		label: "ls",
		description: tool.definition.description,
		promptSnippet: tool.definition.promptSnippet,
		promptGuidelines: tool.definition.promptGuidelines,
		parameters: tool.definition.parameters,
		execute: async (_toolCallId, params, signal, _onUpdate, _extCtx) => {
			const result = await tool.execute(params as LsToolInput, {
				capability: context,
				signal: signal ?? new AbortController().signal,
				sessionId: sessionId(options.sessionId ?? "unknown"),
				cwd,
				metadata: {},
			});
			if (!result.success) {
				throw new Error(result.error ?? "ls failed");
			}
			return result.output as unknown as AgentToolResult<LsToolDetails | undefined>;
		},
		renderCall: template.renderCall as unknown as ToolDefinition<any, any>["renderCall"],
		renderResult: template.renderResult as unknown as ToolDefinition<any, any>["renderResult"],
	};
}
