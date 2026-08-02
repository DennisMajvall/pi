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
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { CapabilityManifest, ToolCapabilityExport } from "@earendil-works/pi-platform/capability";
import { capabilityId, capabilityVersion } from "@earendil-works/pi-platform/identifier";
import type { BuiltinCapability } from "@earendil-works/pi-platform/kernel";
import type { ExtensionContext } from "../core/extensions/types.ts";
import { createReadToolDefinition, type ReadOperations, type ReadToolInput, readSchema } from "../core/tools/read.ts";
import { detectSupportedImageMimeTypeFromFile } from "../utils/mime.ts";

const READ_CAPABILITY_ID = capabilityId("tool.read");

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
			description: "Read the contents of a file. Supports text files and images.",
			parameters: readSchema,
			promptSnippet: "Read file contents",
			promptGuidelines: ["Use read to examine files instead of cat or sed."],
		},
	},
	requires: { services: ["fs"], capabilities: [] },
	permissions: { fs: "read" },
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
			const template = createReadToolDefinition("");

			const tool: ToolCapabilityExport = {
				definition: {
					name: template.name,
					description: template.description,
					parameters: template.parameters,
					promptSnippet: template.promptSnippet,
					promptGuidelines: template.promptGuidelines,
				},
				execute: async (args, toolCtx) => {
					const autoResizeImages = (toolCtx.metadata.autoResizeImages as boolean | undefined) ?? true;
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
					try {
						const output = await definition.execute(
							"platform-read",
							args as ReadToolInput,
							toolCtx.signal,
							undefined,
							extensionContext,
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
