# Pi Capability Platform — Runtime Kernel Walking Skeleton (Step 1.3)

**Status:** Design (pre-implementation)
**Based on:** `docs/CAPABILITY_PLATFORM_CONTRACTS.md` (Step 1.2) and `docs/ARCHITECTURE_REPORT.md` (v0.83.0)
**Date:** 2026-02-08

---

## 1. Objective

Implement the **thinnest possible vertical slice** of the capability platform
runtime: a walking skeleton that takes one real builtin capability (`read`)
through the complete pipeline:

```
discovery → registration → dependency resolution → loading →
lifecycle initialization → exports available → consumed by existing Pi code →
runtime shutdown → capability shutdown
```

Every stage executes for real. No stage is simulated. Advanced functionality is
deliberately absent.

The contracts from Step 1.2 define the interfaces. This document defines
**ownership**: which component does what, in what order, and why.

---

## 2. Component Architecture

```
                    ┌─────────────────────────────┐
                    │            Runtime           │  (orchestrates only)
                    │  create / initialize / start │
                    │  / shutdown                  │
                    └──────┬──────┬───────┬────────┘
                           │      │       │
              owns/creates │      │       │ exposes
              ┌────────────┘      │       └─────────────┐
              ▼                   ▼                     ▼
   ┌──────────────────┐  ┌────────────────┐  ┌──────────────────┐
   │   Discovery      │  │   Registry     │  │  ServiceProvider │
   │  (builtin only)  │  │  (knows what   │  │  (owns service   │
   │  returns static  │  │   exists)      │  │   access)        │
   │  manifests       │  │   state store  │  └────────┬─────────┘
   └──────────────────┘  └──────┬─────────┘           │
                                │                     ▼
   ┌──────────────────┐  ┌──────┴─────────┐  ┌──────────────────┐
   │     Resolver     │  │  Lifecycle     │  │   Event Bus      │
   │  (init order,    │◄─┤  Manager       │  │  (emit/subscribe │
   │   missing/cycles)│  │  (transitions) │  │   /unsubscribe)  │
   └──────────────────┘  └──────┬─────────┘  └──────────────────┘
                                │
                                ▼
                     ┌──────────────────┐
                     │     Loader       │  (factory → CapabilityLifecycle)
                     └──────────────────┘
```

### 2.1 Ownership map

| Concern | Owner | Notes |
|---------|-------|-------|
| **Capability state** | Registry | `RuntimeCapabilityInfo.state` is stored in the registry; the Lifecycle Manager mutates it through the registry's internal state API |
| **Discovery** | Discovery | Walks sources; for the skeleton: one static builtin list supplied by the host |
| **Registration** | Runtime (drives) / Registry (performs) | Runtime asks Discovery for capabilities, then calls `registry.register(manifest, loader)` for each |
| **Dependency resolution** | Resolver | Pure function over registry manifests; produces initialization order + missing/cycle reports |
| **Loading** | Loader | Wraps a builtin factory; `load(ctx) → CapabilityLifecycle` |
| **Lifecycle transitions** | Lifecycle Manager | `registered → resolved → initialized → ready → unloaded`; also `error` on failure |
| **Capability exports** | Registry | `getExports(id)`; written by Lifecycle Manager after `init()` succeeds |
| **Capability contexts** | Lifecycle Manager (creates) / Registry (stores) | Context is per-capability; stored so consumers can build execution contexts |
| **Services** | ServiceProvider | Owns instances; `CapabilityContext` is the mediated view |
| **Lifecycle events** | Lifecycle Manager emits `capability.initialized/ready/error/shutdown`; Registry emits `capability.registered` | Transport is the Event Bus |
| **Bootstrap/shutdown order** | Runtime | Orchestrates; Resolver + Lifecycle Manager supply the ordering |

### 2.2 Boundary rules

- Runtime **coordinates**; it contains no application logic.
- Registry **knows what exists**; it has no lifecycle logic.
- Lifecycle Manager **controls transitions**; it has no storage beyond what the registry gives it.
- Resolver **computes order**; it has no side effects.
- Loader **creates instances**; it has no state.
- ServiceProvider **owns service access**; services have no capability knowledge.
- Event Bus **distributes events**; it has no lifecycle or registry knowledge.
- Components interact through the Step 1.2 contract interfaces only, with two
  documented kernel extensions (see §8.2).

---

## 3. Lifecycle Pipeline

### 3.1 Bootstrap sequence

```
Host (coding-agent)          Runtime                Discovery   Registry     Resolver     Loader     Lifecycle Mgr
      │                        │                      │          │            │           │            │
      │ createRuntime({builtins, services})           │          │            │           │            │
      │───────────────────────►│                      │          │            │           │            │
      │                        │ constructs all components           (no I/O yet)                       │
      │                        │                      │          │            │           │            │
      │ initialize()           │                      │          │            │           │            │
      │───────────────────────►│ discover()           │          │            │           │            │
      │                        │─────────────────────►│          │            │           │            │
      │                        │  DiscoveredCapability[]           │            │           │            │
      │                        │◄─────────────────────│          │            │           │            │
      │                        │ register(manifest, loader)       │            │           │            │
      │                        │─────────────────────────────────►│            │           │            │
      │                        │  emit capability.registered      │            │           │            │
      │                        │─────────────────────────────────►(Event Bus)    │           │            │
      │                        │ resolve(all ids)                 │            │           │            │
      │                        │───────────────────────────────────────────────►│           │            │
      │                        │  initializationOrder              │            │           │            │
      │                        │◄───────────────────────────────────────────────│           │            │
      │                        │ initializeAll(order)                          │           │            │
      │                        │───────────────────────────────────────────────────────────────────────►│
      │                        │  for id in order:                            │           │            │
      │                        │    load(ctx)                                  │           │            │
      │                        │──────────────────────────────────────────────────────────►│            │
      │                        │    lifecycle.init(ctx) → exports             │           │            │
      │                        │───────────────────────────────────────────────────────────────────────►│
      │                        │    registry.setExports(id, exports, ctx)     │           │            │
      │                        │─────────────────────────────────►            │           │            │
      │                        │    registry.setState(id, ready)              │           │            │
      │                        │  emit capability.ready                       │           │            │
      │                        │─────────────────────────────────►(Event Bus)  │           │            │
      │                        │                      │          │            │           │            │
      │ start()                │                      │          │            │           │            │
      │───────────────────────►│  state = running     │          │            │           │            │
```

Ordering guarantee: `initializeAll` initializes capabilities in
`resolver.resolve(allIds).initializationOrder` — dependencies first. Each
capability's `init(ctx)` is awaited before the next begins. If one fails, it is
marked `error` (error containment) and its dependents are skipped; the runtime
still completes startup so the host can operate.

### 3.2 Consumption (by existing Pi code)

```
AgentSession._buildRuntime()            KernelRuntime (singleton)
      │                                        │
      │ getPlatformReadToolDefinition(cwd, opts)│
      │───────────────────────────────────────►│
      │  registry.getExports("tool.read")      │
      │  registry.getContext("tool.read")      │
      │◄───────────────────────────────────────│
      │  builds coding-agent ToolDefinition    │
      │  (definition metadata + execute        │
      │   adapter + TUI renderers)             │
      │                                        │
      │  tool executes later:                  │
      │  definition.execute(args, signal, ctx) │
      │  → capability.tool.execute(args,       │
      │      ToolExecutionContext{cwd, fs ctx, │
      │       signal, sessionId})              │
      │  → ReadOperations backed by            │
      │     FileSystemService (service         │
      │     injection)                         │
```

### 3.3 Shutdown sequence

```
Host                    Runtime               Resolver     Lifecycle Mgr          Registry        Event Bus
  │ shutdown()             │                     │            │                     │               │
  │───────────────────────►│                     │            │                     │               │
  │                        │ shutdownAll()       │            │                     │               │
  │                        │────────────────────────────────►│                     │               │
  │                        │  reverse(order)     │            │                     │               │
  │                        │◄────────────────────────────────│                     │               │
  │                        │  for id in reverse:  │            │                     │               │
  │                        │    lifecycle.shutdown(ctx)       │                     │               │
  │                        │    registry.clearExports(id)     │                     │               │
  │                        │─────────────────────────────────►│                     │               │
  │                        │    registry.setState(id, unloaded)                     │               │
  │                        │  emit capability.shutdown        │                     │               │
  │                        │──────────────────────────────────────────────────────────────────────►│
  │                        │                     │            │                     │               │
```

Shutdown ordering guarantee: **reverse initialization order** — dependents are
shut down before their dependencies. Only capabilities in `ready` state are
shut down.

---

## 4. Dependency Ordering (Resolver)

The Resolver performs a post-order DFS over `manifest.requires.capabilities`:

1. For each requested id, look up its manifest in the registry.
2. Missing dependency → recorded in `missing` (with the depending id), traversal continues.
3. Cycle (node on the current DFS stack) → recorded in `cycles`, traversal stops for that edge.
4. Otherwise: recurse into dependencies first, then append the id to `initializationOrder`.

`initializationOrder` is therefore a valid topological order (dependencies
before dependents) when the graph is acyclic. Semver resolution, conflict
detection, optional dependencies, and graph optimization are **not**
implemented (`checkConflicts` returns `[]`).

Example:

```
fixture.gamma ──requires──► fixture.beta ──requires──► fixture.alpha
                                                          │
                    fixture.missing (not registered) ◄────┘

initializationOrder = [alpha, beta, gamma]
missing = [{ id: missing, ... }]
```

---

## 5. Event Flow

- **Registry** emits `capability.registered` / `capability.unregistered`.
- **Lifecycle Manager** emits `capability.initialized`, `capability.ready`,
  `capability.error`, `capability.shutdown`.
- The **Event Bus** delivers synchronously, in subscription order, awaiting each
  handler; `filter` options are honored; `replay` is requested it throws
  "not implemented" (walking-skeleton behavior, the contract is unchanged).

Events use the Step 1.2 `PlatformEvent` envelope verbatim (id, type, metadata,
payload) via the `createEvent` helper.

---

## 6. Service Injection

- `ServiceProvider` owns service instances. For the pilot only
  `FileSystemService` is implemented (thin `node:fs` wrapper); all other
  services are stubs that throw "not implemented" when any method is called.
- The Lifecycle Manager builds one `CapabilityContext` per capability at
  initialization, injecting: the implemented/stub services, the Event Bus, the
  Registry, and the capability's own id/version/source.
- The `read` capability receives `FileSystemService` through its context and
  uses it to back `ReadOperations` (`readFile`, `access`) — the existing
  pluggable-operations seam of the read tool. This exercises real service
  injection without rewriting read's logic.

---

## 7. The Pilot Capability: read

| Aspect | Design |
|--------|--------|
| Location | `packages/coding-agent/src/platform/read-capability.ts` (host supplies it; kernel is generic) |
| Manifest | `tool.read` v1.0.0, category `tool`, requires `[fs]`, permissions `{ fs: "read" }` |
| Factory | Wraps the **existing** `createReadToolDefinition`; the exported `execute` builds a definition per execution with `cwd` + fs-backed operations from `ToolExecutionContext` |
| Exports | `ToolCapabilityExport` (`definition` metadata + `execute(args, ToolExecutionContext)`) |
| Service use | `FileSystemService.readBytes` + `exists` via `ReadOperations` |
| Why read | Validates discovery, registration, loading, lifecycle, registry, service injection, and the filesystem service — without process or permission complexity |

No other capability is migrated in this step.

---

## 8. Integration with Existing Pi

### 8.1 Consumption point

- `ensurePlatformRuntime()` boots a process-level singleton
  `KernelRuntime` with the `read` builtin. It is idempotent and failure-safe.
- `createAgentSession()` (sdk.ts — the single session-construction path) awaits
  `ensurePlatformRuntime()` before constructing `AgentSession`, so the
  singleton is ready when `_buildRuntime()` runs synchronously.
- `AgentSession._buildRuntime()` sources the `read` tool definition via
  `getPlatformReadToolDefinition(cwd, opts)`:
  - if the kernel is booted → definition is built from the registry exports +
    the capability context + the extracted read renderers;
  - if the kernel is absent or failed → **fallback** to the existing
    `createReadToolDefinition` (no behavioural change).
- All other tools (bash, edit, write, grep, find, ls) remain on the legacy path.

The definition produced by the platform path wraps the **same** factory as the
legacy path, so tool descriptions, schema, prompt snippets, and TUI renderers
are identical.

### 8.2 Kernel extensions beyond the Step 1.2 contracts

Two implementation-level additions (not contract changes):

1. `KernelRegistry.getContext(id)` — returns the stored `CapabilityContext`
   for a capability so consumers can build `ToolExecutionContext`s.
2. `KernelLifecycleManager.initializeAll()/shutdownAll()` — batch lifecycle
   drives used by `Runtime.initialize()/shutdown()`.

---

## 9. Future Extension Points

| Area | Extension point |
|------|-----------------|
| More discovery sources | `CapabilityDiscovery.discoverFrom(source)`; add file/npm/git sources behind the same interface |
| More loaders | `CapabilityLoader` implementations (jiti, native import, sandbox) |
| Versioning | `CapabilityResolver.checkConflicts` + semver ranges in `CapabilityDependency` |
| Hot reload | `LifecycleManager.restart` + registry `unregister` |
| More services | `ServiceProvider` slot per service contract; replace stubs |
| Event features | Event Bus `replay`/`history` behind the unchanged contract |
| Permissions | `PermissionService` enforcement at `CapabilityContext` access |
| Multiple runtimes per process | `createRuntime()` is per-instance; a host may create many |
| Host contracts | Deferred until AgentSession decomposition (Step 5 of the roadmap) |

---

## 10. Explicit Non-Goals (this step)

Host contracts, UI capabilities, RPC runtime, plugin installation, package/git
discovery, marketplace, capability updates, semver conflict handling, advanced
permissions, event replay/persistence, dependency-injection framework, and
service extraction beyond what the pilot requires. All deferred.

---

## 11. Assumptions

1. One process-level runtime singleton is sufficient for the pilot; multi-session
   runtimes come later.
2. The registry per runtime instance; no global state.
3. `FileSystemService` may be cwd-agnostic for absolute paths; workspace-scoped
   per-session service instances are a later phase.
4. Manifest validation is minimal (id/version/category presence); full schema
   validation lands with the registry's production form.
5. Type-only circular imports between contract modules remain acceptable.
6. The existing session/JSONL/settings/tool-definition formats are invariants.
