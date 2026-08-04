/**
 * Platform pilot capability: read (tool.read).
 *
 * The first builtin capability migrated onto the capability platform. It is an
 * adapter over the existing read tool — no rewrite. The manifest is static
 * (discovery without loading); the factory builds a lifecycle whose init
 * exposes the tool via a ToolCapabilityExport.
 *
 * Service injection: the exported execute backs the read tool's pluggable
 * ReadOperations with the platform FileSystemService from CapabilityContext.
 * Image auto-resize comes from the injected SettingsService (ctx.settings),
 * not execution metadata.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { CapabilityManifest, ToolCapabilityExport } from "@earendil-works/pi-platform/capability";
import { capabilityId, capabilityVersion } from "@earendil-works/pi-platform/identifier";
import type { BuiltinCapability } from "@earendil-works/pi-platform/kernel";
import type { ExtensionContext } from "../core/extensions/types.ts";
import { createReadToolDefinition, type ReadOperations, type ReadToolInput, readSchema } from "../core/tools/read.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";
import { executePlatformTool } from "./tool-execution.ts";

const READ_CAPABILITY_ID = capabilityId("tool.read");

// One template per capability (Step 1.10): the manifest's provides.tool prose
// is sourced from it so the two can never drift apart. init reuses the same
// template for the export definition.
const toolTemplate = createReadToolDefinition("");

/**
 * Static manifest. Discovery and registration need only this — no implementation.
 */
export const readManifest: CapabilityManifest = {
	schemaVersion: 1,
	id: READ_CAPABILITY_ID,
	version: capabilityVersion("1.0.0"),
	category: "tool",
	provides: {
		tool: {
			name: "read",
			description: toolTemplate.description,
			parameters: readSchema,
			promptSnippet: toolTemplate.promptSnippet,
			promptGuidelines: toolTemplate.promptGuidelines,
		},
	},
	requires: { services: ["fs", "settings"], capabilities: [] },
	permissions: { fs: "read", config: "read" },
	compatibility: { runtime: ">=0.83.0", peers: {} },
	metadata: {
		name: "Read Tool",
		description: "Read files with offset/limit (platform pilot)",
		tags: ["builtin", "file"],
	},
};

/**
 * The pilot capability: manifest + factory.
 */
export const readCapability: BuiltinCapability = {
	manifest: readManifest,
	factory: async () => ({
		async init(ctx) {
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
				// Settings come from the injected SettingsService (ctx.settings),
				// not execution metadata — the metadata transport is retired.
				execute: async (args, toolCtx) => {
					const autoResizeImages = ctx.settings.get<boolean>("images.autoResize", true) ?? true;
					const model = toolCtx.metadata.model as Model<Api> | undefined;

					// Back the read tool's pluggable operations with the platform
					// FileSystemService (real service injection through the context).
					const operations: ReadOperations = {
						readFile: async (absolutePath) => Buffer.from(await toolCtx.capability.fs.readBytes(absolutePath)),
						access: async (absolutePath) => {
							if (!(await toolCtx.capability.fs.exists(absolutePath))) {
								throw new Error(`ENOENT: no such file or directory, open '${absolutePath}'`);
							}
						},
						detectImageMimeType: detectSupportedImageMimeTypeFromFile,
					};

					const definition = createReadToolDefinition(toolCtx.cwd, { operations, autoResizeImages });
					const extensionContext = (model ? { model } : undefined) as unknown as ExtensionContext;
					return executePlatformTool(definition, "platform-read", args as ReadToolInput, toolCtx.signal, {
						extensionContext,
					});
				},
			};

			// Additive export for peer consumption: the grep capability reads
			// full file contents for context lines via this primitive. The read
			// tool's execute applies truncation, so grep must not route through
			// it. CapabilityExports is arbitrary, so this is not a contract
			// change; existing consumers read only exports.tool.
			const readTextFile = async (absolutePath: string): Promise<string> => {
				return Buffer.from(await ctx.fs.readBytes(absolutePath)).toString("utf-8");
			};

			return { tool, readTextFile };
		},
		async shutdown() {
			// Nothing to release in the pilot.
		},
	}),
};
