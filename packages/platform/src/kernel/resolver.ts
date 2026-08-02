/**
 * Walking-skeleton capability resolver.
 *
 * Computes dependency existence and initialization ordering only: a post-order
 * DFS over `requires.capabilities` that yields dependencies before dependents.
 * Missing dependencies and cycles are reported, not resolved. Semver
 * resolution, conflict detection, optional dependencies, and graph
 * optimization are intentionally not implemented.
 */

import type { CapabilityDependency, CapabilityManifest } from "../capability/index.ts";
import type { CapabilityId } from "../identifier/index.ts";
import type { CapabilityResolver, ResolvedCapabilityGraph, VersionConflict } from "../runtime/index.ts";

type ManifestLookup = (id: CapabilityId) => CapabilityManifest | undefined;

export class SimpleCapabilityResolver implements CapabilityResolver {
	private readonly getManifest: ManifestLookup;

	constructor(getManifest: ManifestLookup) {
		this.getManifest = getManifest;
	}
	async resolve(ids: CapabilityId[]): Promise<ResolvedCapabilityGraph> {
		const order: CapabilityId[] = [];
		const visited = new Set<CapabilityId>();
		const onStack = new Set<CapabilityId>();
		const missing: CapabilityDependency[] = [];
		const cycles: CapabilityId[][] = [];
		const dependencies = new Map<CapabilityId, CapabilityDependency[]>();

		const visit = (id: CapabilityId, stack: CapabilityId[]): void => {
			if (visited.has(id)) return;
			if (onStack.has(id)) {
				const cycleStart = stack.indexOf(id);
				cycles.push([...stack.slice(cycleStart), id]);
				return;
			}
			const manifest = this.getManifest(id);
			if (!manifest) {
				// Unknown id reached through a dependency edge; recorded by caller.
				return;
			}
			onStack.add(id);
			const deps = manifest.requires?.capabilities ?? [];
			dependencies.set(id, deps);
			const nextStack = [...stack, id];
			for (const dep of deps) {
				if (!this.getManifest(dep.id)) {
					missing.push(dep);
					continue;
				}
				visit(dep.id, nextStack);
			}
			onStack.delete(id);
			visited.add(id);
			order.push(id);
		};

		for (const id of ids) {
			if (!this.getManifest(id)) {
				missing.push({ id, version: "*" });
				continue;
			}
			visit(id, []);
		}

		return { initializationOrder: order, dependencies, missing, cycles };
	}

	async checkConflicts(_ids: CapabilityId[]): Promise<VersionConflict[]> {
		// Semver conflict detection is deferred.
		return [];
	}
}
