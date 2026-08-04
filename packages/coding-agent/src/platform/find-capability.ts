/**
 * Platform pilot capability: find (tool.find).
 *
 * The fourth builtin capability migrated onto the capability platform, after
 * read, bash, and grep. It is an adapter over the existing find tool — no
 * rewrite. The manifest is static (discovery without loading); the factory
 * builds a lifecycle whose init exposes the tool via a ToolCapabilityExport.
 *
 * Service injection: the exported execute backs the find tool's pluggable
 * FindOperations with the platform FileSystemService from CapabilityContext.
 * The fd binary is never consulted — the custom-glob path of the tool runs
 * the search through fs.glob instead.
 *
 * fd-compat rules owned by this adapter (the fs service stays standard
 * glob): a pattern without a slash is prefixed with a recursive glob
 * prefix (fd's basename matching — '*.ts' finds .ts files at any depth), a
 * pattern with a slash is used as-is, and both are evaluated relative to
 * the search path. Hidden entries follow the standard dotfile rule (fd
 * --hidden is not reproduced); .gitignore awareness stays an fd feature on
 * the legacy path.
 */

import type { CapabilityManifest, ToolCapabilityExport } from "@earendil-works/pi-platform/capability";
import { capabilityId, capabilityVersion } from "@earendil-works/pi-platform/identifier";
import type { BuiltinCapability } from "@earendil-works/pi-platform/kernel";
import type { FileSystemService } from "@earendil-works/pi-platform/service";
import nodePath from "path";
import { createFindToolDefinition, type FindOperations, type FindToolInput, findSchema } from "../core/tools/find.ts";
import { executePlatformTool } from "./tool-execution.ts";

const FIND_CAPABILITY_ID = capabilityId("tool.find");

// One template per capability (Step 1.10): the manifest's provides.tool prose
// is sourced from it so the two can never drift apart. init reuses the same
// template for the export definition.
const toolTemplate = createFindToolDefinition("");

/**
 * Static manifest. Discovery and registration need only this — no implementation.
 */
export const findManifest: CapabilityManifest = {
	schemaVersion: 1,
	id: FIND_CAPABILITY_ID,
	version: capabilityVersion("1.0.0"),
	category: "tool",
	provides: {
		tool: {
			name: "find",
			description: toolTemplate.description,
			parameters: findSchema,
			promptSnippet: toolTemplate.promptSnippet,
			promptGuidelines: toolTemplate.promptGuidelines,
		},
	},
	requires: { services: ["fs"], capabilities: [] },
	permissions: { fs: "read" },
	compatibility: { runtime: ">=0.83.0", peers: {} },
	metadata: {
		name: "Find Tool",
		description: "Search files by glob pattern (platform pilot)",
		tags: ["builtin", "search"],
	},
};

/** The ignore list the find tool passes to custom glob operations. */
const FIND_IGNORE = ["**/node_modules/**", "**/.git/**"];

/**
 * The pilot capability: manifest + factory.
 */
export const findCapability: BuiltinCapability = {
	manifest: findManifest,
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
					// Back the find tool's pluggable operations with the platform
					// FileSystemService (real service injection through the context).
					const operations = createFileSystemServiceFindOperations(toolCtx.capability.fs);

					const definition = createFindToolDefinition(toolCtx.cwd, { operations });
					return executePlatformTool(definition, "platform-find", args as FindToolInput, toolCtx.signal);
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
 * FindOperations backed by the platform FileSystemService.
 *
 * The glob maps the tool's searchPath-relative pattern onto the workspace-
 * relative (or absolute, when the search path is outside the workspace)
 * pattern the fs service expects, and requests absolute results — the tool
 * relativizes them against the search root itself.
 */
function createFileSystemServiceFindOperations(fs: FileSystemService): FindOperations {
	return {
		exists: (absolutePath) => fs.exists(absolutePath),
		glob: async (pattern, searchPath, { ignore }) => {
			const workspaceRoot = fs.getWorkspaceRoot();
			const relativeSearchPath = toPosix(nodePath.relative(workspaceRoot, searchPath));
			const posixPattern = toPosix(pattern);
			// fd-compat: patterns without a '/' match basenames at any depth.
			const effectivePattern = posixPattern.includes("/") ? posixPattern : `**/${posixPattern}`;
			const insideWorkspace = !relativeSearchPath.startsWith("..");
			const fullPattern = insideWorkspace
				? relativeSearchPath
					? `${relativeSearchPath}/${effectivePattern}`
					: effectivePattern
				: `${toPosix(searchPath)}/${effectivePattern}`;
			return fs.glob(fullPattern, { absolute: true, ignore: [...FIND_IGNORE, ...ignore] });
		},
	};
}

function toPosix(value: string): string {
	return value.split(nodePath.sep).join("/");
}
