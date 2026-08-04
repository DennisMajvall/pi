/**
 * Platform pilot capability: ls (tool.ls).
 *
 * The fifth builtin capability migrated onto the capability platform, after
 * read, bash, grep, and find. It is an adapter over the existing ls tool —
 * no rewrite. The manifest is static (discovery without loading); the factory
 * builds a lifecycle whose init exposes the tool via a ToolCapabilityExport.
 *
 * Service injection: the exported execute backs the ls tool's pluggable
 * LsOperations with the platform FileSystemService from CapabilityContext.
 * Directory listing goes through fs.list (includeHidden — the ls tool shows
 * dotfiles); per-entry stat calls bridge the contract's boolean
 * FileStat.isDirectory onto the tool's predicate-typed shape.
 */

import type { CapabilityManifest, ToolCapabilityExport } from "@earendil-works/pi-platform/capability";
import { capabilityId, capabilityVersion } from "@earendil-works/pi-platform/identifier";
import type { BuiltinCapability } from "@earendil-works/pi-platform/kernel";
import type { FileSystemService } from "@earendil-works/pi-platform/service";
import { createLsToolDefinition, type LsOperations, type LsToolInput, lsSchema } from "../core/tools/ls.ts";
import { executePlatformTool } from "./tool-execution.ts";

const LS_CAPABILITY_ID = capabilityId("tool.ls");

// One template per capability (Step 1.10): the manifest's provides.tool prose
// is sourced from it so the two can never drift apart. init reuses the same
// template for the export definition.
const toolTemplate = createLsToolDefinition("");

/**
 * Static manifest. Discovery and registration need only this — no implementation.
 */
export const lsManifest: CapabilityManifest = {
	schemaVersion: 1,
	id: LS_CAPABILITY_ID,
	version: capabilityVersion("1.0.0"),
	category: "tool",
	provides: {
		tool: {
			name: "ls",
			description: toolTemplate.description,
			parameters: lsSchema,
			promptSnippet: toolTemplate.promptSnippet,
			promptGuidelines: toolTemplate.promptGuidelines,
		},
	},
	requires: { services: ["fs"], capabilities: [] },
	permissions: { fs: "read" },
	compatibility: { runtime: ">=0.83.0", peers: {} },
	metadata: {
		name: "Ls Tool",
		description: "List directory contents (platform pilot)",
		tags: ["builtin", "file"],
	},
};

/**
 * The pilot capability: manifest + factory.
 */
export const lsCapability: BuiltinCapability = {
	manifest: lsManifest,
	factory: async () => ({
		async init() {
			// Template for definition metadata; the exported execute builds a
			// fresh definition per execution using the execution cwd and the
			// injected FileSystemService.
			const template = toolTemplate;

			const tool: ToolCapabilityExport = {
				definition: {
					name: template.name,
					description: template.description,
					parameters: template.parameters,
					promptSnippet: template.promptSnippet,
					promptGuidelines: template.promptGuidelines,
				},
				execute: async (args, toolCtx) => {
					// Back the ls tool's pluggable operations with the platform
					// FileSystemService (real service injection through the context).
					const operations = createFileSystemServiceLsOperations(toolCtx.capability.fs);

					const definition = createLsToolDefinition(toolCtx.cwd, { operations });
					return executePlatformTool(definition, "platform-ls", args as LsToolInput, toolCtx.signal);
				},
			};

			return { tool };
		},
		async shutdown() {
			// Nothing to release in the pilot.
		},
	}),
};

/**
 * LsOperations backed by the platform FileSystemService.
 *
 * readdir maps fs.list entries (FileStat[]) onto the entry-name strings the
 * tool expects; stat bridges the contract's boolean isDirectory onto the
 * tool's predicate shape; exists maps the boolean check.
 */
function createFileSystemServiceLsOperations(fs: FileSystemService): LsOperations {
	return {
		exists: (absolutePath) => fs.exists(absolutePath),
		stat: async (absolutePath) => {
			const stat = await fs.stat(absolutePath);
			return { isDirectory: () => stat.isDirectory };
		},
		readdir: async (absolutePath) =>
			(await fs.list(absolutePath, { includeHidden: true })).map((entry) => entry.name),
	};
}
