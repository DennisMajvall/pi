/**
 * Shared per-execution execution for platform tool capabilities (Step 1.9
 * cleanup, retiring the Step 1.8 report's per-execution duplication debt).
 *
 * Every tool capability's exported execute builds a fresh ToolDefinition for
 * the execution cwd and runs it with the same try/catch result mapping. This
 * helper is that mapping; the two special cases (read's model-shaped
 * extensionContext, bash's metadata-carried extensionContext + onUpdate)
 * are options, not forks.
 */

import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ToolDefinition } from "../core/extensions/types.ts";

export type PlatformToolResult = { success: true; output: unknown } | { success: false; isError: true; error: string };

export interface ExecutePlatformToolOptions {
	/** ExtensionContext to pass to the definition's execute (read, bash). */
	extensionContext?: ExtensionContext;
	/** Live-update callback for streaming tools (bash). */
	onUpdate?: AgentToolUpdateCallback;
}

/**
 * Execute a freshly built tool definition for one platform tool call and
 * map the outcome onto the ToolCapabilityExport ToolResult shape. A thrown
 * error becomes `{ success: false, isError: true, error }` with the error
 * message; a returned AgentToolResult becomes `{ success: true, output }`.
 */
export async function executePlatformTool<TInput>(
	definition: ToolDefinition<any, any, any>,
	toolCallId: string,
	input: TInput,
	signal: AbortSignal | undefined,
	options: ExecutePlatformToolOptions = {},
): Promise<PlatformToolResult> {
	try {
		const output = await definition.execute(
			toolCallId,
			input as never,
			signal,
			options.onUpdate,
			options.extensionContext ?? (undefined as unknown as ExtensionContext),
		);
		return { success: true, output };
	} catch (error) {
		return { success: false, isError: true, error: error instanceof Error ? error.message : String(error) };
	}
}
