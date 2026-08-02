/**
 * Platform pilot capability: grep (tool.grep).
 *
 * The third builtin capability migrated onto the capability platform, after
 * read and bash. It is an adapter over the existing grep tool — no rewrite.
 * The manifest is static (discovery without loading); the factory builds a
 * lifecycle whose init exposes the tool via a ToolCapabilityExport.
 *
 * Firsts for the platform:
 * - Peer-capability dependency: `requires.capabilities: [tool.read]`. The
 *   resolver's post-order DFS initializes read before grep; grep's init reads
 *   the read capability's `readTextFile` export through its own
 *   CapabilityContext registry (`ctx.capabilities.getExports`) and backs the
 *   grep tool's `readFile` operation with it. Shutdown runs in reverse order
 *   (grep unloads before read).
 * - No new service: the file side of grep (directory check + context reads)
 *   is backed by the existing FileSystemService (`stat`) and the read peer.
 *
 * Compromise (documented): the ripgrep search process itself is spawned by
 * the tool via node:child_process on both the legacy and platform paths —
 * GrepOperations only covers the file side, so there is no seam to move the
 * search behind.
 */

import type { CapabilityManifest, ToolCapabilityExport } from "@earendil-works/pi-platform/capability";
import { capabilityId, capabilityVersion } from "@earendil-works/pi-platform/identifier";
import type { BuiltinCapability } from "@earendil-works/pi-platform/kernel";
import type { ExtensionContext } from "../core/extensions/types.ts";
import { createGrepToolDefinition, type GrepOperations, type GrepToolInput, grepSchema } from "../core/tools/grep.ts";

const GREP_CAPABILITY_ID = capabilityId("tool.grep");
const READ_CAPABILITY_ID = capabilityId("tool.read");

/**
 * Static manifest. Discovery and registration need only this — no implementation.
 */
export const grepManifest: CapabilityManifest = {
	schemaVersion: 1,
	id: GREP_CAPABILITY_ID,
	version: capabilityVersion("1.0.0"),
	category: "tool",
	provides: {
		tool: {
			name: "grep",
			description:
				"Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore.",
			parameters: grepSchema,
			promptSnippet: "Search file contents for patterns (respects .gitignore)",
		},
	},
	requires: {
		services: ["fs"],
		// Peer-capability dependency: grep reads file contents for context
		// lines via the read capability's readTextFile export. Hard dependency:
		// grep cannot initialize without tool.read.
		capabilities: [{ id: READ_CAPABILITY_ID, version: "*" }],
	},
	permissions: { fs: "read" },
	compatibility: { runtime: ">=0.83.0", peers: {} },
	metadata: {
		name: "Grep Tool",
		description: "Search file contents with context lines (platform pilot)",
		tags: ["builtin", "search"],
	},
};

/** The read capability's additive primitive export that grep consumes. */
interface ReadTextFileExport {
	readTextFile: (absolutePath: string) => Promise<string>;
}

/**
 * The pilot capability: manifest + factory.
 */
export const grepCapability: BuiltinCapability = {
	manifest: grepManifest,
	factory: async () => ({
		async init(ctx) {
			// Peer consumption: the lifecycle guarantees tool.read is Ready
			// before tool.grep (requires.capabilities init order), so its
			// exports are available here. A missing peer fails init loudly —
			// the hard-dependency semantic.
			const readExports = ctx.capabilities.getExports<ReadTextFileExport>(READ_CAPABILITY_ID);
			if (!readExports?.readTextFile) {
				throw new Error(
					`grep capability requires the read capability (${READ_CAPABILITY_ID}) to be initialized first`,
				);
			}

			// Template for definition metadata; the exported execute builds a
			// fresh definition per execution using the execution cwd and the
			// injected FileSystemService + read peer.
			const template = createGrepToolDefinition("");

			const tool: ToolCapabilityExport = {
				definition: {
					name: template.name,
					description: template.description,
					parameters: template.parameters,
					promptSnippet: template.promptSnippet,
					promptGuidelines: template.promptGuidelines,
				},
				execute: async (args, toolCtx) => {
					// Back the grep tool's pluggable operations with platform
					// services: isDirectory via the FileSystemService, readFile
					// via the read capability's readTextFile export (full file,
					// no truncation — required for correct context blocks).
					const operations: GrepOperations = {
						isDirectory: async (absolutePath) => (await toolCtx.capability.fs.stat(absolutePath)).isDirectory,
						readFile: (absolutePath) => readExports.readTextFile(absolutePath),
					};

					const definition = createGrepToolDefinition(toolCtx.cwd, { operations });
					try {
						const output = await definition.execute(
							"platform-grep",
							args as GrepToolInput,
							toolCtx.signal,
							undefined,
							undefined as unknown as ExtensionContext,
						);
						return { success: true, output };
					} catch (error) {
						return {
							success: false,
							isError: true,
							error: error instanceof Error ? error.message : String(error),
						};
					}
				},
			};

			return { tool };
		},
		async shutdown() {
			// Nothing to release in the pilot.
		},
	}),
};
