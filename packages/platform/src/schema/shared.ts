/**
 * Shared schema primitives.
 *
 * Leaf module (typebox only) so higher schema modules can reuse the canonical
 * identifier schemas without a circular import. Both `./index.ts` and
 * `./plan.ts` import from here.
 */

import { Type } from "typebox";

/** Capability id: `<category>.<name>` */
export const CapabilityIdSchema = Type.String({
	pattern: "^[a-z]+(\\.[a-z][a-z0-9_-]*)+$",
	description: "Capability identifier in the form <category>.<name>",
	examples: ["tool.read", "command.compact", "model.anthropic"],
});

/** Semantic version (SemVer 2.0.0 subset) */
export const CapabilityVersionSchema = Type.String({
	pattern: "^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z-.]+)?(\\+[0-9A-Za-z-.]+)?$",
	description: "SemVer version of the capability",
	examples: ["1.2.3", "2.0.0-rc.1"],
});
