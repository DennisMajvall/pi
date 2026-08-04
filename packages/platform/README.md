# @earendil-works/pi-platform

Capability platform contracts + walking-skeleton runtime kernel for pi.

## Contract subpaths (implementation-free)

interfaces, types, branded identifiers, const objects, TypeBox schemas,
constants, and documentation comments. No runtime behavior.

| Subpath | Contents |
|---------|----------|
| `/identifier` | Branded identifiers (CapabilityId, EventId, SessionId, ...) |
| `/capability` | Capability manifests, lifecycle, context, per-category declarations/exports |
| `/runtime` | Runtime kernel contract interfaces: registry, resolver, loader, discovery, lifecycle |
| `/service` | Platform service contracts (Settings, Session, FS, Process, Network, Auth, Cache, Events, Permissions, Logging, Configuration, Telemetry) |
| `/event` | Platform event model + canonical event types |
| `/error` | Canonical platform error hierarchy |
| `/schema` | TypeBox schemas for manifests, events, permissions, configuration |

## `/kernel` (runtime behavior — walking skeleton)

The first executable version of the platform runtime: a thin, end-to-end
implementation that takes one real builtin capability through the complete
lifecycle (discovery → registration → resolution → loading → initialization →
exports → shutdown).

- `createRuntime({ builtins })` — boots an uninitialized kernel
- `KernelRuntime.initialize()/start()/shutdown()`
- `KernelCapabilityRegistry` — registration, queries, exports, contexts
- `KernelLifecycleManager` — dependency-aware init, reverse-order shutdown
- `KernelServiceProvider` — FileSystemService + not-implemented stubs
- `KernelEventBus` — emit / subscribe / unsubscribe (sync, ordered)
- `BuiltinCapabilityDiscovery` / `SimpleCapabilityResolver` / `BuiltinCapabilityLoader`

## Design

See `docs/CAPABILITY_PLATFORM_CONTRACTS.md` (contracts, Step 1.2),
`docs/capability-platform/RUNTIME_KERNEL_DESIGN.md` (kernel collaboration design, Step 1.3), and
`docs/capability-platform/RUNTIME_KERNEL_REPORT.md` (Step 1.3 results).

## Development

```bash
npm run build   # typecheck + emit declarations
```

Checks (from repo root): `tsgo --noEmit`, `biome check packages/platform`,
`node ../../node_modules/vitest/dist/cli.js --run test/kernel.test.ts`.
