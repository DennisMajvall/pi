/**
 * Platform pilot capability: bash (tool.bash).
 *
 * The second builtin capability migrated onto the capability platform, after
 * read. It is an adapter over the existing bash tool — no rewrite. The
 * manifest is static (discovery without loading); the factory builds a
 * lifecycle whose init exposes the tool via a ToolCapabilityExport.
 *
 * Service injection: the exported execute backs the bash tool's pluggable
 * BashOperations with the platform ProcessService (plus FileSystemService for
 * the working-directory existence check) from CapabilityContext. Shell path
 * and command prefix come from the injected SettingsService (ctx.settings),
 * not execution metadata.
 */

import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { CapabilityManifest, ToolCapabilityExport } from "@earendil-works/pi-platform/capability";
import { capabilityId, capabilityVersion } from "@earendil-works/pi-platform/identifier";
import type { BuiltinCapability } from "@earendil-works/pi-platform/kernel";
import type { FileSystemService, ProcessHandle, ProcessService } from "@earendil-works/pi-platform/service";
import type { ExtensionContext } from "../core/extensions/types.ts";
import {
	type BashOperations,
	type BashToolDetails,
	type BashToolInput,
	bashSchema,
	createBashToolDefinition,
	resolveTimeoutMs,
} from "../core/tools/bash.ts";
import { normalizePath } from "../utils/paths.ts";
import { getShellConfig, getShellEnv, trackDetachedChildPid, untrackDetachedChildPid } from "../utils/shell.ts";
import { executePlatformTool } from "./tool-execution.ts";

const BASH_CAPABILITY_ID = capabilityId("tool.bash");

/**
 * Static manifest. Discovery and registration need only this — no implementation.
 */
export const bashManifest: CapabilityManifest = {
	schemaVersion: 1,
	id: BASH_CAPABILITY_ID,
	version: capabilityVersion("1.0.0"),
	category: "tool",
	provides: {
		tool: {
			name: "bash",
			description:
				"Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
			parameters: bashSchema,
			promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
			promptGuidelines: ["Inspect PI_* environment variables for current model and session details."],
		},
	},
	requires: { services: ["process", "settings"], capabilities: [] },
	permissions: { process: "spawn", config: "read" },
	compatibility: { runtime: ">=0.83.0", peers: {} },
	metadata: {
		name: "Bash Tool",
		description: "Execute bash commands with streaming output (platform pilot)",
		tags: ["builtin", "process"],
	},
};

/**
 * The pilot capability: manifest + factory.
 */
export const bashCapability: BuiltinCapability = {
	manifest: bashManifest,
	factory: async () => ({
		async init(ctx) {
			// Template for definition metadata; the exported execute builds a
			// fresh definition per execution using the execution cwd and the
			// injected ProcessService.
			const template = createBashToolDefinition("");

			const tool: ToolCapabilityExport = {
				definition: {
					name: template.name,
					description: template.description,
					parameters: template.parameters,
					promptSnippet: template.promptSnippet,
					promptGuidelines: template.promptGuidelines,
				},
				execute: async (args, toolCtx) => {
					// Shell path and command prefix come from the injected
					// SettingsService (ctx.settings), not execution metadata —
					// the metadata transport is retired. normalizePath preserves
					// SettingsManager.getShellPath()'s tilde expansion.
					const shellPathSetting = ctx.settings.get<string>("shellPath");
					const shellPath = shellPathSetting ? normalizePath(shellPathSetting) : undefined;
					const commandPrefix = ctx.settings.get<string>("shellCommandPrefix");
					const extensionContext = toolCtx.metadata.extensionContext as ExtensionContext | undefined;
					const onUpdate = toolCtx.metadata.onUpdate as
						| AgentToolUpdateCallback<BashToolDetails | undefined>
						| undefined;

					// Back the bash tool's pluggable operations with the platform
					// ProcessService (real service injection through the context).
					const operations = createProcessServiceBashOperations({
						process: toolCtx.capability.process,
						fs: toolCtx.capability.fs,
						shellPath,
					});

					const definition = createBashToolDefinition(toolCtx.cwd, {
						operations,
						commandPrefix,
						shellPath,
					});
					return executePlatformTool(definition, "platform-bash", args as BashToolInput, toolCtx.signal, {
						extensionContext: extensionContext as unknown as ExtensionContext,
						onUpdate,
					});
				},
			};

			return { tool };
		},
		async shutdown() {
			// Nothing to release in the pilot.
		},
	}),
};

interface ProcessServiceBashOperationsOptions {
	process: ProcessService;
	fs: FileSystemService;
	shellPath?: string;
}

/**
 * BashOperations backed by the platform ProcessService.
 *
 * Mirrors createLocalBashOperations.exec: shell resolution via getShellConfig,
 * working-directory existence check, stdin/argv command transport, streaming
 * stdout+stderr, timeout and abort killing the process tree, and detached-pid
 * tracking so shutdown hooks can reap children. The only difference is that
 * the process itself is spawned and reaped through the ProcessService instead
 * of node:child_process directly.
 */
function createProcessServiceBashOperations(options: ProcessServiceBashOperationsOptions): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = getShellConfig(options.shellPath);
			if (!(await options.fs.exists(cwd))) {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const handle = options.process.spawn(
				shellConfig.shell,
				commandFromStdin ? shellConfig.args : [...shellConfig.args, command],
				{
					cwd,
					detached: process.platform !== "win32",
					env: (env ?? getShellEnv()) as Record<string, string>,
					stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
					// The kernel kills the process tree when this signal aborts.
					signal,
				},
			);
			if (commandFromStdin) {
				void writeStdin(handle, command);
			}
			if (handle.pid > 0) trackDetachedChildPid(handle.pid);

			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			try {
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						void handle.kill();
					}, timeoutMs);
				}
				const exitCode = await pumpProcessOutput(handle, onData);
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				return { exitCode };
			} finally {
				if (handle.pid > 0) untrackDetachedChildPid(handle.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
			}
		},
	};
}

/** Write the command to the process stdin (stdin transport) and close. */
async function writeStdin(handle: ProcessHandle, command: string): Promise<void> {
	try {
		const writer = handle.stdin?.getWriter();
		if (writer) {
			await writer.write(command);
			await writer.close();
		}
	} catch {
		// stdin closed by a fast-exiting shell; the process owns the outcome.
	}
}

/**
 * Pump the process stdout/stderr Web Streams into onData while waiting for
 * exit. Fire-and-forget readers feed onData as chunks arrive; the kernel's
 * exit wait resolves when the process terminates (destroying the streams),
 * after which readers are cancelled.
 */
async function pumpProcessOutput(handle: ProcessHandle, onData: (data: Buffer) => void): Promise<number> {
	const readers: Array<ReadableStreamDefaultReader<Uint8Array>> = [];
	const pump = async (stream: ReadableStream<Uint8Array> | null) => {
		if (!stream) return;
		const reader = stream.getReader();
		readers.push(reader);
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				onData(Buffer.from(value));
			}
		} catch {
			// Stream destroyed by exit handling; output already delivered via onData.
		}
	};
	void pump(handle.stdout);
	void pump(handle.stderr);
	try {
		return await handle.exited;
	} finally {
		for (const reader of readers) {
			try {
				await reader.cancel();
			} catch {
				// Already errored/closed.
			}
		}
	}
}
