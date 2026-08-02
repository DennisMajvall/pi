/**
 * Walking-skeleton capability loader.
 *
 * Loads only builtin (factory) capabilities: invokes the factory from the
 * discovery load spec to produce a CapabilityLifecycle. No jiti, no sandboxing,
 * no remote/package loading, no caching.
 */

import type { CapabilityContext, CapabilityLifecycle, CapabilityManifest } from "../capability/index.ts";
import { PlatformError } from "../error/index.ts";
import type { CapabilityLoader, CapabilityLoadSpec, ValidationResult } from "../runtime/index.ts";

export class BuiltinCapabilityLoader implements CapabilityLoader {
	private readonly loadSpec: CapabilityLoadSpec;

	constructor(loadSpec: CapabilityLoadSpec) {
		this.loadSpec = loadSpec;
	}
	async load(ctx: CapabilityContext): Promise<CapabilityLifecycle> {
		if (this.loadSpec.type !== "factory" || !this.loadSpec.factory) {
			throw new PlatformError(
				`Load spec '${this.loadSpec.type}' is not implemented in the walking skeleton (factory loading only)`,
				{ code: "NOT_IMPLEMENTED" },
			);
		}
		return this.loadSpec.factory(ctx);
	}

	async validate(_manifest: CapabilityManifest): Promise<ValidationResult> {
		return { valid: true, errors: [], warnings: [] };
	}
}
