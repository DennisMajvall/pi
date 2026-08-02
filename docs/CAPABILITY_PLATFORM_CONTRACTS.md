# Pi Capability Platform — Contract Layer (Step 1.2)

**Status:** Design + contracts package (pre-implementation)
**Based on:** `docs/ARCHITECTURE_REPORT.md` (verified against v0.83.0 source)
**Package:** `@earendil-works/pi-platform` (new, `packages/platform`)
**Date:** 2026-02-08

---

## 1. Deliverable Overview

This step establishes the **foundational contracts** for the future Capability
Platform. The deliverable is a new package, `@earendil-works/pi-platform`,
containing **only shared contracts**:

- interfaces
- types
- branded identifiers
- const objects (enum equivalents)
- TypeBox schemas
- constants
- documentation comments

**Constraints honored:**

| Constraint                                                      | Status                                                 |
| --------------------------------------------------------------- | ------------------------------------------------------ |
| No runtime behavior (registry, event bus, DI container, loader) | ✅ Contracts only                                      |
| No migration of existing functionality                          | ✅ Nothing imported the package                        |
| No existing code modified                                       | ✅ Only `package-lock.json` gained the workspace entry |
| Application compiles and behaves exactly as before              | ✅ `tsgo --noEmit` passes repo-wide                    |

The only runtime-adjacent code in the package is the minimal machinery needed
to make contracts _usable_: branded-id factory functions (type casts), const
objects, error classes with serialization, and event factory helpers. No
platform infrastructure is implemented.

---

## 2. Directory Structure

```
packages/platform/
├── package.json              # @earendil-works/pi-platform, deps: typebox only
├── tsconfig.json             # dev config (noEmit)
├── tsconfig.build.json       # build config (declaration emit)
└── src/
    ├── index.ts              # package root: re-exports all contract modules
    ├── capability/index.ts   # capability contracts
    ├── runtime/index.ts      # runtime kernel contracts
    ├── service/index.ts      # platform service contracts
    ├── event/index.ts        # platform event model
    ├── error/index.ts        # canonical platform errors
    ├── identifier/index.ts   # branded identifiers (single source of truth)
    └── schema/index.ts       # TypeBox schemas (validation/serialization)
```

Subpath exports (`@earendil-works/pi-platform/capability`, `/runtime`,
`/service`, `/event`, `/error`, `/identifier`, `/schema`) allow consumers to
import only what they need.

---

## 3. Contract Hierarchy

```
@earendil-works/pi-platform
├── identifier/               ← no dependencies (bottom layer)
│   ├── CapabilityId, CapabilityVersion, EventId, ServiceId
│   ├── RuntimeId, WorkspaceId, SessionId, UserId, ProjectId
│   ├── ToolId, CommandId, ModelId, ProviderId, ExtensionId
│   ├── ThemeId, SkillId, PromptTemplateId
│   ├── ConfigKey, PermissionKey, FeatureFlagKey
│   ├── TagId, LabelId, BranchId, EntryId
│   ├── CorrelationId, CausationId, RequestId
│   ├── TaskId, PlanId, StepId, WorkerId, SubagentId
│   ├── MemoryKey, CacheKey, LockId
│   └── AnyId (union)
├── event/                    ← depends on identifier
│   ├── PlatformEvent, EventMetadata, EventType, EventSource
│   ├── EventPriority (const), EventScope (const)
│   ├── PlatformEventType (const: 40+ canonical event types)
│   ├── payload interfaces per event domain
│   └── EventSubscription, SubscribeOptions, EventBusStats
├── capability/               ← depends on identifier, event, service, runtime (type-only)
│   ├── CapabilityManifest, CapabilityProvides, CapabilityRequires
│   ├── CapabilityCategory (const), CapabilityState (const), CapabilityStatus (const)
│   ├── CapabilityDependency, CapabilityPermissions, CapabilityCompatibility
│   ├── CapabilityMetadata, CapabilityConfiguration, CapabilityFeatureFlags
│   ├── CapabilityHealth, RuntimeCapabilityInfo
│   ├── per-category exports: Tool/Command/Prompt/Context/Model/Theme/
│   │   Policy/Executor/Memory/Orchestration/UI/Event capability exports
│   ├── CapabilityLifecycle, CapabilityContext, CapabilityExports
│   └── SourceInfo
├── runtime/                  ← depends on capability, service, identifier (type-only)
│   ├── Runtime, RuntimeContext, RuntimeHealth
│   ├── CapabilityRegistry, CapabilityRegistration, CapabilityQuery
│   ├── CapabilityResolver, ResolvedCapabilityGraph, VersionConflict
│   ├── CapabilityLoader, CapabilityDiscovery, DiscoveredCapability
│   ├── CapabilitySource, CapabilityLoadSpec, CapabilityFactory
│   ├── LifecycleManager, LifecyclePhase (const), LifecycleListener
│   └── ServiceProvider
├── service/                  ← depends on identifier, capability, event, runtime (type-only)
│   ├── SettingsService, SessionService, FileSystemService
│   ├── ProcessService, NetworkService, AuthService, CacheService
│   ├── EventBusService, PermissionService, LoggingService
│   ├── ConfigurationService, TelemetryService
│   └── supporting types (Session, SessionEntry, ExecResult, Credential, ...)
├── error/                    ← depends on identifier, runtime (type-only)
│   ├── PlatformError (base, serializable)
│   ├── CapabilityError, DependencyError, PermissionError
│   ├── ConfigurationError, ValidationError, LifecycleError
│   ├── RegistryError, ServiceError, EventError, RuntimeError, HostError
│   ├── SerializationError, NotFoundError, ConflictError
│   ├── TimeoutError, CancellationError
│   ├── ErrorCode (const), error type guards, toPlatformError()
│   └── PlatformErrorJSON
└── schema/                   ← no internal deps (typebox only)
    ├── CapabilityManifestSchema, CapabilityPermissionsSchema
    ├── CapabilityConfigurationSchema, CapabilityFeatureFlagsSchema
    ├── PlatformEventSchema, EventMetadataSchema
    ├── CapabilityIdSchema, CapabilityVersionSchema, CapabilityCategorySchema
    ├── CapabilityStateSchema, CapabilityDependencySchema, ...
    └── PlatformSchemas (registry of all schemas)
```

### Dependency rules between contract modules

| From       | To                                     | Kind                                                                                                |
| ---------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| identifier | —                                      | none (bottom)                                                                                       |
| event      | identifier                             | type-only                                                                                           |
| capability | identifier, event, service, runtime    | type-only (circular with service/runtime is allowed: all imports are `import type`, erased at emit) |
| runtime    | capability, service, identifier        | type-only                                                                                           |
| service    | identifier, capability, event, runtime | type-only                                                                                           |
| error      | identifier, runtime                    | type-only                                                                                           |
| schema     | —                                      | typebox only                                                                                        |

Type-only circularity (`capability ↔ runtime`, `capability ↔ service`) is safe:
every edge is `import type` or a value import of a pure const/factory, and no
module executes another module at load time.

---

## 4. Public API Overview

| Subpath       | Contents                                                                              | Consumers (future)                    |
| ------------- | ------------------------------------------------------------------------------------- | ------------------------------------- |
| `/identifier` | All branded identifiers + factories                                                   | Every module; replaces raw strings    |
| `/event`      | Event model, canonical event types, payload contracts                                 | Event bus, capabilities, hosts        |
| `/capability` | Capability vocabulary + per-category export shapes                                    | Capability authors, registry, hosts   |
| `/runtime`    | Kernel interfaces: registry, resolver, loader, discovery, lifecycle, service provider | Kernel implementation, hosts          |
| `/service`    | 12 service interfaces + supporting types                                              | Service implementations, capabilities |
| `/error`      | Canonical error hierarchy + guards + codes                                            | All layers                            |
| `/schema`     | TypeBox schemas for manifests, events, permissions, config                            | Runtime validation, RPC, docs         |

---

## 5. Contract Explanations and Rationale

### 5.1 Why a separate package (not a module inside coding-agent)

1. **API stability boundary.** The contracts must remain valid for years. A
   package boundary makes breaking changes explicit (semver), which in-process
   modules do not.
2. **Multi-runtime support.** The design must support multiple frontends
   (TUI/print/RPC/SDK consumers) and runtimes (Node, Bun binary). A standalone
   package can be consumed by all without pulling in the coding agent.
3. **Zero-runtime guarantee is enforceable.** A package with only types can be
   built and tree-shaken to nothing; reviewers can verify there is no
   infrastructure hiding inside.
4. **Precedent.** `@earendil-works/pi-protocol` already demonstrates the
   contracts-as-package pattern in this repo.

### 5.2 Capability contracts

**CapabilityId / CapabilityVersion** (branded, from `/identifier`). Branding
prevents passing a session id where a capability id is expected, and gives
`parseCapabilityId()` a stable shape (`<category>.<name>`). Capability ids are
the platform's primary addressing scheme.

**CapabilityManifest** — the static, JSON-serializable declaration of a
capability. The central design decision is that a manifest must contain
**enough metadata for runtime discovery without loading the capability**:
id, version, category, provides (serializable subset), requires (services +
peer capabilities), permissions, compatibility, and human metadata. This makes
listing/querying/UI-grouping cheap and safe. Function-typed `provides` fields
are declared structurally; implementations are loaded later via
`CapabilityLoader`.

**CapabilityCategory** — a closed const-object taxonomy (tool, command, prompt,
context, model, theme, policy, executor, memory, orchestration, ui, event).
Rationale: discovery, policy, and UI grouping need a coarse, stable
classification. It is intentionally a closed set for now; custom categories can
be added in a later phase if the ecosystem demands them (see §8).

**CapabilityState / CapabilityStatus / CapabilityLifecycle** — state machine
vocabulary (discovered → registered → resolved → initialized → ready → active →
unloading → unloaded → error) and the lifecycle interface (`init`, `shutdown`,
optional `onSessionStart/End/onConfigChange`). The lifecycle deliberately does
**not** include execution; capabilities export typed interfaces that others
call, keeping execution policy (queues, retries, permissions) at the runtime.

**CapabilityContext** — the _only_ injection point. It exposes the 12 platform
services, the registry, and the capability's own metadata. Rationale: mediated
access (from the old design's dependency rules) — capabilities never import
services directly, so the runtime can enforce permissions, lifecycle, and
versioning at the boundary. This is the single most important contract: it is
the contract between the platform and every capability author.

**CapabilityExports** — the return value of `init()`. Typed per category via
the `*CapabilityExport` interfaces (e.g. `ToolCapabilityExport`). Hosts consume
exports via the registry; capabilities consume peers via
`CapabilityRegistry.getExports()`.

**CapabilityPermissions** — coarse, extensible permission vocabulary
(fs/network/process/config/spawn at none→full levels plus custom keys). Coarse
now by design (§8); the vocabulary is versioned inside the manifest so finer
permissions can be added without breaking existing manifests.

**CapabilityConfiguration / CapabilityFeatureFlags** — per-capability runtime
configuration, distinct from `SettingsService` (user settings). Kept separate
so capabilities can be configured without polluting user settings.

**CapabilityHealth / CapabilityStatus / RuntimeCapabilityInfo** — introspection
contracts: runtime consumers (TUI footer, RPC, monitors) can observe
capability health and state without coupling to implementations.

**Per-category exports** (`ToolCapabilityExport`, `CommandCapabilityExport`,
...) define what each category _means_ at the platform level. Tool and Command
export shapes intentionally mirror the existing pi concepts
(`ToolDefinition` with TypeBox `parameters`, `promptSnippet`,
`promptGuidelines`; commands with `argumentHint` and completions) so the future
migration has a 1:1 mapping from today's code (see §8 mapping).

### 5.3 Runtime contracts

**Runtime** — the kernel contract. It owns registry, event bus, lifecycle, and
services; `initialize() → start() → shutdown()` is the runtime lifecycle. The
interface deliberately has **no business-logic methods** (no `prompt`, no
`executeTool`): the runtime coordinates, it does not execute. This is the
contractual form of the "MUST NEVER DO" list from the old design.

**CapabilityRegistry** — the single source of truth for all capabilities in a
runtime. `register(manifest, loader)` separates declaration from
implementation, so discovery can happen without loading. `getExports()`
provides typed peer access. Per-runtime instances (not a global) so multiple
sessions/tests don't interfere.

**CapabilityLoader** — `load(ctx) → CapabilityLifecycle`. Kept separate from
the registry so loading is lazy, swappable (jiti today; native import, network,
sandbox later), and testable.

**CapabilityDiscovery / CapabilitySource / CapabilityLoadSpec** — abstraction
over the current sources (builtin, inline factories, files, npm, git, config,
SDK). `DiscoveredCapability` pairs a manifest with a load spec, matching the
current `ResourceLoader` + `PackageManager` split.

**CapabilityResolver** — dependency graph resolution: initialization order,
cycles, missing deps, version conflicts. Returns `ResolvedCapabilityGraph` and
`VersionConflict[]` so the runtime can report precise diagnostics.

**LifecycleManager** — owns state transitions and emits lifecycle events.
Separate from the registry because one registry may serve many lifecycle
managers (e.g. session-scoped lifecycle with a runtime-scoped registry).

**ServiceProvider** — typed access to all 12 services, plus a `get()` escape
hatch for dynamic access. The capability-facing surface is the narrower
`CapabilityContext`.

**RuntimeContext** — read-only context for services and host integration
(runtime id, workspace, session, registry, events, services).

### 5.4 Service contracts

All services are interfaces with **no implementation logic**. Each service
contract documents why it exists, who owns it, and what it intentionally does
not do (via doc comments in the source).

| Service                  | Responsibilities (contract)                                                                                           | Maps to today                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| **SettingsService**      | get/set by dotted path, change subscription, schemas, load/save, reset                                                | `SettingsManager`                       |
| **SessionService**       | create/open/fork/list/delete/export/import; entry types incl. `thinking_level_change`, `model_change`, `session_info` | `SessionManager`                        |
| **FileSystemService**    | read/write/delete/stat/glob/watch, sandboxed relative to workspace                                                    | tools, `ResourceLoader` fs access       |
| **ProcessService**       | spawn/exec/shell/PTY, process handles, kill                                                                           | `bash-executor`, `tools/bash`           |
| **NetworkService**       | request/fetch/WebSocket/proxy/certs/ping                                                                              | `http-dispatcher`, providers            |
| **AuthService**          | credential storage, OAuth flows, API key env/runtime overrides                                                        | `AuthStorage`, `RuntimeCredentials`     |
| **CacheService**         | key-value + TTL + invalidation + stats                                                                                | (implicit in ModelRuntime/models store) |
| **EventBusService**      | typed emit, subscriptions, replay history, stats                                                                      | `ExtensionRunner.emit`, `EventBus`      |
| **PermissionService**    | check/request/grant/revoke; user consent prompts                                                                      | (future; today trust store is coarse)   |
| **LoggingService**       | structured levels, child loggers                                                                                      | `console`/`chalk` today                 |
| **ConfigurationService** | per-capability config, feature flags, schema validation                                                               | (future)                                |
| **TelemetryService**     | metrics, traces, events                                                                                               | `telemetry.ts`, `usage-totals`          |

Design note: **ConfigurationService vs SettingsService** are deliberately
separate. Settings are user-owned and human-editable; capability configuration
is machine-managed and capability-owned. Merging them today would couple user
data with platform bookkeeping.

### 5.5 Event contracts

**PlatformEvent** — the canonical event envelope: `id`, `type`, `metadata`,
`payload`. **EventMetadata** carries timestamp, source, priority, scope,
correlation/causation ids, tags. This is enough to support tracing
(`correlationId`/`causationId`), filtering (`tags`), ordering (`priority`),
and delivery scoping (`EventScope`) without committing to any bus
implementation.

**EventPriority / EventScope** — const objects (enum equivalents, erasable
syntax). Priorities are numeric (0/50/100/200) so ordering is a comparison, not
a string convention.

**PlatformEventType** — a const of canonical event type strings
(`capability.*`, `tool.*`, `command.*`, `session.*`, `model.*`, `prompt.*`,
`context.*`, `compaction.*`, `settings.*`, `permission.*`, `extension.*`,
`host.*`, `system.*`). Having canonical names prevents the current
"event types scattered" problem (54 interfaces in `extensions/types.ts`,
~25 emitted from AgentSession) from growing worse.

**Payload contracts** — per-domain payload interfaces (`ToolExecutedPayload`,
`SessionForkedPayload`, ...) so event consumers are typed. The extension
system's current event vocabulary (e.g. `tool_execution_start`) is intentionally
_not_ frozen into this layer; those are agent-loop events, mapped to platform
events during migration.

### 5.6 Error contracts

`PlatformError` is the serializable base (code, status, metadata, timestamp,
errorId, cause, `toJSON()`/`fromJSON()`). The hierarchy:

- **CapabilityError** (+ `phase`: discovery/registration/resolution/init/execution/shutdown)
- **DependencyError** (+ reason: not_found/version_conflict/circular/missing/incompatible/load_failed)
- **PermissionError**, **ConfigurationError**, **ValidationError**
- **LifecycleError**, **RegistryError**, **ServiceError**, **EventError**
- **RuntimeError**, **HostError**, **SerializationError**
- **NotFoundError**, **ConflictError**, **TimeoutError**, **CancellationError**

Rationale: every failure mode the platform will need is named and structured
now, so error handling code written today will not need rework when the runtime
lands. `ErrorCode` const and type guards keep programmatic handling stable.

### 5.7 Schema contracts

TypeBox schemas are the **serializable canonical forms**. They cover the
minimum required set — `CapabilityManifestSchema`, `PlatformEventSchema`,
`CapabilityPermissionsSchema`, `CapabilityConfigurationSchema` — plus
identifier, category, state, dependency, health, and error schemas.
`PlatformSchemas` is a named registry of all schemas for tooling (docs, codegen,
RPC type definitions).

The schema module exports constants only; the canonical TypeScript types live
in the sibling modules. Consumers derive `Static<typeof XSchema>` when needed.

---

## 6. Contracts Intentionally Left Undefined (Later Phases)

| Contract                                                                           | Why deferred                                                                                                         |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Event bus implementation**                                                       | A bus has runtime behavior (queueing, ordering, replay storage); only the event _model_ is contracted now            |
| **Registry/resolver/loader/discovery implementations**                             | Implementations belong to the runtime step, not the contracts step                                                   |
| **DI container**                                                                   | Capabilities get `CapabilityContext`; a container is an implementation detail of `ServiceProvider`                   |
| **Host interfaces** (TUIHost/PrintHost/RPCHost)                                    | Host contracts depend on how AgentSession decomposes (Step 6 of the old plan); deferring avoids premature commitment |
| **`PromptService`/`ToolService`/`ModelService`/`CompactionService` decomposition** | Those are refactors of existing code, explicitly out of scope for a contracts-only step                              |
| **Capability persistence/migration hooks** (`migrate(oldVersion, data)`)           | Only needed once capabilities are versioned in the wild                                                              |
| **Sandboxing/isolation contracts**                                                 | Depends on executor capability decisions in a later phase                                                            |
| **Approval/consent UI flow types**                                                 | `PermissionService` declares the surface; the UI contract comes with hosts                                           |
| **Custom capability categories**                                                   | Closed set for now; extensible later via manifest `category` versioning                                              |

---

## 7. Architectural Assumptions

1. **Capability = manifest + loader + lifecycle exports**, not a class. Assumed
   so capabilities stay serializable, loadable lazily, and swappable.
2. **One registry per runtime instance**, not global. Needed for multi-session
   and testing.
3. **Mediated access everywhere**: capabilities reach services only via
   `CapabilityContext`, peers only via `CapabilityRegistry.getExports()` or
   events. No direct cross-capability imports.
4. **pi-agent-core stays the agent loop.** The platform wraps it as a
   capability consumer; it is not replaced.
5. **Existing formats are invariants**: session JSONL v3, settings JSON,
   TypeBox/JSON-Schema tool definitions, jiti extension loading, pi-tui
   components. Contracts are designed around them, not against them.
6. **Type-only circular imports between contract modules are acceptable.**
   All are erased at emit; no runtime cycles.
7. **The 12 services map 1:1 onto today's concerns** (§5.4 table), so
   implementations can be extracted incrementally without redesign.
8. **Event types use a fresh canonical namespace**; the extension event
   vocabulary is bridged during migration, not frozen into the platform layer.
9. **Branded ids and factory functions are the minimum runtime allowed** in a
   contracts package; everything else is type/const/schema-only.
10. **SemVer from day one**: manifest `schemaVersion: 1`, capability semver,
    runtime compatibility range (`>=0.83.0` baseline in examples).

---

## 8. Concerns and Future Limitations

1. **CapabilityId collision with extension tools.** Today extension tools are
   registered by bare name (`read`, `bash`, custom names). The platform id
   scheme (`tool.<name>`) is namespaced, but migration must map the existing
   name-based allowlist/denylist (`--tools`, `--exclude-tools`) without
   breaking user config. The `ToolId` branded type and the
   `ToolCapabilityExport.definition` shape (which keeps the bare `name`) are
   designed so both views coexist during migration.

2. **Closed category set.** New categories (e.g. `data`, `view`) require a
   schema bump. Mitigation: `CapabilityCategorySchema` is a union; adding a
   literal is backward compatible for readers, and `schemaVersion` guards
   writers.

3. **Coarse permissions.** `CapabilityPermissions` uses none→full levels. Real
   capabilities may need finer grants (read-only bash, per-host network). The
   `additionalProperties: true` schema escape hatch and the per-key string
   union are the intended extension points; a finer `PermissionKey` grammar
   (`fs.read:/repo/src`) is a later-phase refinement.

4. **Branded ids vs serialization.** Branded types are compile-time only; ids
   serialize as plain strings. Factories do not validate at runtime (except
   prefix checks like `toolId`). Validation is deferred to the schema layer,
   which means callers can create invalid ids. Acceptable for a contracts
   package; runtime validation lands with the registry.

5. **`crypto.randomUUID()` in id factories** requires a runtime with
   WebCrypto/Node crypto. Node >= 22 and Bun both have it; browser-only
   consumers must provide a fallback. Noted in the factory docs.

6. **Two parallel naming schemes** (interfaces in `/capability` etc., schemas
   in `/schema`) means a consumer must remember that `CapabilityManifest` (the
   type) and `CapabilityManifestSchema` (the validator) are distinct. Mitigated
   by the `Schema` suffix convention and `PlatformSchemas` registry.

7. **Event payload typing is generic.** `PlatformEvent.payload` is `unknown`;
   typed access requires per-type narrowing (`isEventType`, payload interfaces).
   A fully discriminated union of all payloads was considered and rejected —
   it would make adding event types a breaking change for every consumer.

8. **Host-bound capabilities (UI category) risk coupling.** `UICapabilityExport`
   mentions components but does not commit to pi-tui types. The risk is that
   hosts pull capability UI contracts toward their own component models; the
   contract deliberately keeps UI contributions declarative (type, key,
   factory returning an opaque `render()`).

9. **Circular type-only imports** between capability/service/runtime make the
   graph harder to read and can confuse tooling that doesn't understand
   `import type` erasure. Kept for type ergonomics; if it becomes a problem,
   the split points are documented (§3).

10. **No host contracts yet** means the "multiple frontends" goal is only
    half-contracted: the runtime side is stable, but host-side consumption
    contracts (how a host renders capability exports) are deferred. This is
    intentional but should be revisited before the interactive-mode decoupling
    phase.

---

## 9. Mapping to Current Architecture (Migration Surface)

The following map is provided for the later migration phases; nothing here is
implemented in this step.

| Current construct                      | Future contract                                            | Migration notes                                                |
| -------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| `tools/index.ts` (7 builtin tools)     | `ToolCapabilityExport`                                     | 1:1 via `ToolDefinition` (already TypeBox-shaped)              |
| `extensions/loader.ts` + jiti          | `CapabilityLoader` + `CapabilityDiscovery`                 | Loader currently returns `ExtensionRuntime`; wrap to lifecycle |
| `extensions/runner.ts` emit()          | `EventBusService` + `PlatformEvent`                        | Map agent/extension events to canonical types                  |
| `extensions/types.ts` ExtensionContext | `CapabilityContext` (subset)                               | Old `ctx` becomes a facade over the new context                |
| `settings-manager.ts`                  | `SettingsService`                                          | Getter/setter surface (109 methods) is the sprawl to contain   |
| `session-manager.ts`                   | `SessionService`                                           | Entry types already enumerated in `SessionEntryType`           |
| `model-runtime.ts`                     | `ModelCapabilityExport` + `AuthService` + `NetworkService` | Provider composition is the highest-risk extraction            |
| `resource-loader.ts`                   | `CapabilityDiscovery` + `CapabilitySource`                 | Sources (file/npm/git/inline) map directly                     |
| `system-prompt.ts`                     | (prompt building)                                          | Deferred to AgentSession decomposition phase                   |
| `trust-manager.ts`                     | `PermissionService` (coarse subset)                        | Trust store becomes the first permission grant source          |

---

## 10. Validation Performed

- `tsgo --noEmit -p packages/platform/tsconfig.build.json` — clean
- `tsgo --noEmit` (repo-wide) — clean
- `biome check packages/platform/src --error-on-warnings` — clean
- `npm run check:ts-imports` — clean
- `npm run check:pinned-deps` — clean
- `npm run check:shrinkwrap` — clean
- `npm run check:install-lock:coding-agent` — clean
- Root `package-lock.json` updated with the `packages/platform` workspace entry
- No existing source file modified (`git status`: only `package-lock.json` +
  new `packages/platform/`)
