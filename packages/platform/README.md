# @earendil-works/pi-platform

Capability platform contracts for pi.

**This package contains ONLY shared contracts:**

- interfaces, types, branded identifiers
- const objects (enum equivalents), TypeBox schemas, constants
- documentation comments

**Zero runtime behavior.** No registry, no event bus, no dependency injection,
no capability loading, no migrations. Nothing in the existing codebase depends
on this package yet.

## Modules

| Subpath | Contents |
|---------|----------|
| `/identifier` | Branded identifiers (CapabilityId, EventId, SessionId, ...) |
| `/capability` | Capability manifests, lifecycle, context, per-category exports |
| `/runtime` | Runtime kernel contracts: registry, resolver, loader, discovery, lifecycle |
| `/service` | Platform service contracts (Settings, Session, FS, Process, Network, Auth, Cache, Events, Permissions, Logging, Configuration, Telemetry) |
| `/event` | Platform event model + canonical event types |
| `/error` | Canonical platform error hierarchy |
| `/schema` | TypeBox schemas for manifests, events, permissions, configuration |

## Design

See `docs/CAPABILITY_PLATFORM_CONTRACTS.md` in the repo root for the full
design rationale, contract hierarchy, assumptions, and known limitations.

## Development

```bash
npm run build   # typecheck + emit declarations
```

Checks (from repo root): `tsgo --noEmit`, `biome check packages/platform/src`.
