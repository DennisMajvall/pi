/**
 * Platform pilot capability: write (tool.write).
 *
 * The sixth builtin capability migrated onto the capability platform, after
 * read, bash, grep, find, and ls. It is an adapter over the existing write
 * tool — no rewrite. The manifest is static (discovery without loading); the
 * factory builds a lifecycle whose init exposes the tool via a
 * ToolCapabilityExport.
 *
 * Firsts for the platform:
 * - First non-read permission: `permissions: { fs: "write" }`.
 * - First consumption of the implemented fs write surface (Step 1.9):
 *   the exported execute backs the write tool's pluggable WriteOperations
 *   with the injected FileSystemService — `mkdir` creates parent directories
 *   (`recursive: true`, matching the tool), `writeFile` writes through
 *   `ctx.fs.write` with the default utf8 encoding.
 */

import type { CapabilityManifest, ToolCapabilityExport } from "@earendil-works/pi-platform/capability";
import { capabilityId, capabilityVersion } from "@earendil-works/pi-platform/identifier";
import type { BuiltinCapability } from "@earendil-works/pi-platform/kernel";
import type { FileSystemService } from "@earendil-works/pi-platform/service";
import {
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	writeSchema,
} from "../core/tools/write.ts";
import { executePlatformTool } from "./tool-execution.ts";

const WRITE_CAPABILITY_ID = capabilityId("tool.write");

// One template per capability (Step 1.10): the manifest's provides.tool prose
// is sourced from it so the two can never drift apart. init reuses the same
// template for the export definition.
const toolTemplate = createWriteToolDefinition("");

/**
 * Static manifest. Discovery and registration need only this — no implementation.
 */
export const writeManifest: CapabilityManifest = {
	schemaVersion: 1,
	id: WRITE_CAPABILITY_ID,
	version: capabilityVersion("1.0.0"),
	category: "tool",
	provides: {
		tool: {
			name: "write",
			description: toolTemplate.description,
			parameters: writeSchema,
			promptSnippet: toolTemplate.promptSnippet,
			promptGuidelines: toolTemplate.promptGuidelines,
		},
	},
	requires: { services: ["fs"], capabilities: [] },
	permissions: { fs: "write" },
	compatibility: { runtime: ">=0.83.0", peers: {} },
	metadata: {
		name: "Write Tool",
		description: "Write file contents (platform pilot)",
		tags: ["builtin", "file"],
	},
};

/**
 * The pilot capability: manifest + factory.
 */
export const writeCapability: BuiltinCapability = {
	manifest: writeManifest,
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
					// Back the write tool's pluggable operations with the platform
					// FileSystemService (real service injection through the context).
					const operations = createFileSystemServiceWriteOperations(toolCtx.capability.fs);

					const definition = createWriteToolDefinition(toolCtx.cwd, { operations });
					return executePlatformTool(definition, "platform-write", args as WriteToolInput, toolCtx.signal);
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
 * WriteOperations backed by the platform FileSystemService.
 *
 * mkdir maps the tool's unconditional parent-directory creation onto
 * fs.mkdir with recursive: true; writeFile maps onto fs.write with the
 * default utf8 encoding (string content).
 */
function createFileSystemServiceWriteOperations(fs: FileSystemService): WriteOperations {
	return {
		mkdir: (dir) => fs.mkdir(dir, { recursive: true }),
		writeFile: (absolutePath, content) => fs.write(absolutePath, content),
	};
}
