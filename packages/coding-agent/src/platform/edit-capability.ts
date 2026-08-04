/**
 * Platform pilot capability: edit (tool.edit).
 *
 * The seventh builtin capability migrated onto the capability platform. It
 * is an adapter over the existing edit tool — no rewrite. The manifest is
 * static (discovery without loading); the factory builds a lifecycle whose
 * init exposes the tool via a ToolCapabilityExport.
 *
 * Service injection: the exported execute backs the edit tool's pluggable
 * EditOperations with the platform FileSystemService from CapabilityContext.
 * readFile returns a Buffer via fs.readBytes (so BOM/line-ending preservation
 * in edit-diff.ts is byte-identical to the legacy path); writeFile writes
 * through fs.write; access reproduces the legacy fs.access(R_OK | W_OK)
 * error surface from service methods — ENOENT via fs.exists, EACCES via an
 * empty-append writability probe (opening a file for append requires write
 * permission, so a read-only file throws EACCES at open).
 *
 * No tool.read peer edge: edit's readFile needs a Buffer, which the read
 * capability's string-typed readTextFile export does not provide; fs.readBytes
 * is the right backing. Peer edges stay a statement of fact — grep needs
 * tool.read's export, edit does not.
 */

import type { CapabilityManifest, ToolCapabilityExport } from "@earendil-works/pi-platform/capability";
import { capabilityId, capabilityVersion } from "@earendil-works/pi-platform/identifier";
import type { BuiltinCapability } from "@earendil-works/pi-platform/kernel";
import type { FileSystemService } from "@earendil-works/pi-platform/service";
import { createEditToolDefinition, type EditOperations, type EditToolInput, editSchema } from "../core/tools/edit.ts";
import { executePlatformTool } from "./tool-execution.ts";

const EDIT_CAPABILITY_ID = capabilityId("tool.edit");

/**
 * Static manifest. Discovery and registration need only this — no implementation.
 */
export const editManifest: CapabilityManifest = {
	schemaVersion: 1,
	id: EDIT_CAPABILITY_ID,
	version: capabilityVersion("1.0.0"),
	category: "tool",
	provides: {
		tool: {
			name: "edit",
			description:
				"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
			parameters: editSchema,
			promptSnippet:
				"Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
		},
	},
	requires: { services: ["fs"], capabilities: [] },
	permissions: { fs: "write" },
	compatibility: { runtime: ">=0.83.0", peers: {} },
	metadata: {
		name: "Edit Tool",
		description: "Edit files with exact text replacement (platform pilot)",
		tags: ["builtin", "file"],
	},
};

/**
 * The pilot capability: manifest + factory.
 */
export const editCapability: BuiltinCapability = {
	manifest: editManifest,
	factory: async () => ({
		async init() {
			// Template for definition metadata; the exported execute builds a
			// fresh definition per execution using the execution cwd and the
			// injected FileSystemService.
			const template = createEditToolDefinition("");

			const tool: ToolCapabilityExport = {
				definition: {
					name: template.name,
					description: template.description,
					parameters: template.parameters,
					promptSnippet: template.promptSnippet,
					promptGuidelines: template.promptGuidelines,
				},
				execute: async (args, toolCtx) => {
					// Back the edit tool's pluggable operations with the platform
					// FileSystemService (real service injection through the context).
					const operations = createFileSystemServiceEditOperations(toolCtx.capability.fs);

					const definition = createEditToolDefinition(toolCtx.cwd, { operations });
					return executePlatformTool(definition, "platform-edit", args as EditToolInput, toolCtx.signal);
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
 * EditOperations backed by the platform FileSystemService.
 *
 * access reproduces the legacy `fs.access(R_OK | W_OK)` error surface from
 * service methods: fs.exists yields ENOENT, and an empty append to the file
 * requires write permission, so a read-only file throws EACCES at open (the
 * probe writes nothing). Readability is not probed — a mode-0222 file fails
 * later at readFile with a raw EACCES (documented compromise).
 */
function createFileSystemServiceEditOperations(fs: FileSystemService): EditOperations {
	return {
		access: async (absolutePath) => {
			if (!(await fs.exists(absolutePath))) {
				const error = new Error(`ENOENT: no such file or directory, open '${absolutePath}'`) as Error & {
					code?: string;
				};
				error.code = "ENOENT";
				throw error;
			}
			// Writability probe: opening for append requires write permission.
			await fs.append(absolutePath, "");
		},
		readFile: async (absolutePath) => Buffer.from(await fs.readBytes(absolutePath)),
		writeFile: (absolutePath, content) => fs.write(absolutePath, content),
	};
}
