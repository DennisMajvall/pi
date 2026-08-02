/**
 * Walking-skeleton capability discovery.
 *
 * Builtin capabilities only: returns the static list of manifests + factories
 * supplied by the host. The architecture makes future discovery sources
 * straightforward to add behind the CapabilityDiscovery contract.
 */

import type { CapabilityManifest } from "../capability/index.ts";
import { PlatformError } from "../error/index.ts";
import type {
	CapabilityDiscovery,
	CapabilityFactory,
	CapabilitySource,
	DiscoveredCapability,
} from "../runtime/index.ts";

/** A builtin capability: a static manifest plus a factory that builds its lifecycle. */
export interface BuiltinCapability {
	manifest: CapabilityManifest;
	factory: CapabilityFactory;
}

export class BuiltinCapabilityDiscovery implements CapabilityDiscovery {
	private readonly builtins: readonly BuiltinCapability[];

	constructor(builtins: readonly BuiltinCapability[]) {
		this.builtins = builtins;
	}
	async discover(): Promise<DiscoveredCapability[]> {
		return this.builtins.map((builtin) => ({
			source: { type: "builtin", identifier: builtin.manifest.id },
			manifest: builtin.manifest,
			loadSpec: { type: "factory", factory: builtin.factory },
		}));
	}

	async discoverFrom(source: CapabilitySource): Promise<DiscoveredCapability[]> {
		if (source.type !== "builtin") {
			throw new PlatformError(`Discovery source '${source.type}' is not implemented in the walking skeleton`, {
				code: "NOT_IMPLEMENTED",
			});
		}
		return this.discover();
	}
}
