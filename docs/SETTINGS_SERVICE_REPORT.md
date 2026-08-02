# Pi Capability Platform — SettingsService Extraction behind SettingsManager: Design Report (Step 1.6)

**Status:** Implemented and validated
**Based on:** `docs/SETTINGS_SERVICE_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

The platform's **first config-bearing service**: a real `SettingsService`
implementation adapting the existing `SettingsManager`, injected into the
kernel's `KernelServiceProvider` at `bootPlatformRuntime` (the
`NodeProcessService` precedent). Capabilities now read configuration through
`ctx.settings.get(...)`; the execution-metadata settings bridge (`read`'s
`autoResizeImages`, `bash`'s `commandPrefix`/`shellPath`) is retired. No new
capability and no new tool migration — a pure service extraction, and the
cheapest one in the chain (Step 1.4 report §8, item 2; Step 1.5 report §8,
item 1).

| Component | Implementation | Minimal scope honored |
| --- | --- | --- |
| SettingsService | `SettingsManagerService` (`packages/coding-agent/src/platform/settings-service.ts`) | `get` (dotted-path over the effective merged snapshot), `getAll`, `load`→`reload()`, `save`→`flush()`; `set`/`registerSchema`/`subscribe`/`subscribeAny`/`reset`/`getSettingsPath` throw `NOT_IMPLEMENTED` (mirrors `NodeProcessService.spawnPty`) |
| SettingsManager accessor | `getEffectiveSettings()` added to `settings-manager.ts` | The one additive change to the manager — exposes the already-computed merged view (global+project+overrides); no getter touched |
| ServiceProvider | `KernelServiceProviderOptions.settings?: SettingsService`; constructor wires `options.settings ?? not-implemented stub` | Same shape as the `process` option; default unchanged, so `createRuntime` callers that don't supply settings keep today's stub behavior |
| Capability transport | read/bash `execute` read `ctx.settings.get(...)`; manifests add `"settings"` to `requires.services` and `config: "read"` to `permissions` | grep untouched (has no settings); `metadata.model` (read) and `metadata.extensionContext`/`onUpdate` (bash) stay — those are genuine per-execution extras |
| Boot wiring | `ensurePlatformRuntime({ settingsManager })`; `bootPlatformRuntime` builds `SettingsManagerService(options.settingsManager ?? SettingsManager.inMemory())` | `createAgentSession` passes the session's real manager; tests/other callers get a pure in-memory manager; idempotent singleton unchanged |
| Consumption | `_buildRuntime` drops `autoResizeImages`/`commandPrefix`/`shellPath` from the platform option calls; legacy fallback path keeps them | Platform definitions read settings per-execution; legacy definitions still capture at build time |

## 2. Validation Results

- `packages/coding-agent/test/settings-service.test.ts` — **8/8 pass** (new):
  - `get` dotted-path resolution (nested `images.autoResize`, top-level
    `shellCommandPrefix`), default fallback, `undefined` when no default;
  - project-over-global merge (custom two-scope storage) and
    `applyOverrides` reflected in `getAll`;
  - `load` re-reads from storage (`reload` semantics — mutated store, then
    loaded), `save` resolves (write-queue flush);
  - walking-skeleton scope: `set`/`registerSchema`/`subscribe`/`subscribeAny`/
    `reset`/`getSettingsPath` all throw `PlatformError` `NOT_IMPLEMENTED`;
  - kernel integration: a supplied `SettingsService` is injected through the
    capability context (`ctx.settings` is the real service, stub not used).
- `packages/coding-agent/test/platform-runtime.test.ts` — **7/7 pass** (was
  6): the read tests now boot with an injected settings service, and a new
  recording-service test proves read's execute reads `images.autoResize` via
  `ctx.settings` with empty metadata — the transport-retirement proof.
- `packages/coding-agent/test/bash-capability.test.ts` — **13/13 pass** (was
  13): "honors commandPrefix and shellPath from execution metadata" became
  "reads commandPrefix and shellPath from the injected settings service"
  (`SettingsManager.inMemory({ shellCommandPrefix })`, empty metadata); the
  consumption test that passed `commandPrefix` through options became one that
  boots the runtime with a settings manager and executes with none.
- `packages/coding-agent/test/grep-capability.test.ts` — **12/12 pass**
  (unchanged; grep touches no settings).
- `packages/platform/test/kernel.test.ts` — **17/17 pass** (was 16; +1: a
  supplied `settings` override is injected through the capability context;
  the "unknown services are not-implemented stubs" test is untouched — the
  default is still a stub). `test/process-service.test.ts` (18/18) unchanged.
- Existing behaviour unchanged: `test/tools.test.ts` (74/74),
  `test/session-id-readonly.test.ts` (7/7), `test/agent-session-concurrent.test.ts`
  (7/7), `test/agent-session-dynamic-tools.test.ts` (4/4),
  `test/suite/agent-session-bash-persistence.test.ts` (11/11),
  `test/suite/agent-session-prompt.test.ts` (13/13) all pass — the suite
  harness constructs AgentSession directly, exercising the legacy fallback
  with the session's own `settingsManager`.
- Repo-wide `npm run check` green: biome (988 files), pinned-deps,
  ts-imports, shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke.
- `packages/platform` dist rebuilt (`tsgo -p tsconfig.build.json`) so the
  coding-agent build config and the running binary resolve the new
  `KernelServiceProviderOptions.settings` (dist is gitignored; Step 1.4
  precedent).

## 3. Architectural Decisions

1. **The adapter lives in coding-agent, not the platform package.**
   `SettingsManager` imports host code (`config.ts`, `utils/paths.ts`,
   `http-dispatcher.ts`, pi-tui/pi-ai types), so the kernel stays generic and
   the host supplies the implementation through
   `KernelServiceProviderOptions` — exactly the `fs`/`process` pattern. The
   platform package gained only the option slot.
2. **Walking-skeleton scope: read side only.** `get`/`getAll` plus
   `load`→`reload()` and `save`→`flush()` (thin, honest mappings over the
   manager's own persistence lifecycle). The write/observe side throws
   `NOT_IMPLEMENTED`: `SettingsManager` persists through per-field typed
   setters with modified-field tracking, has no schema registry, no
   change-notification emitter, and private storage paths — a generic
   dotted-path `set` would replicate machinery that belongs to the Workspaces
   phase. This mirrors `NodeProcessService` implementing spawn/exec/shell/kill
   while `spawnPty` throws.
3. **`getEffectiveSettings()` is the single additive SettingsManager
   change.** The merged view is already computed internally; exposing a
   structured clone costs nothing and keeps `deepMergeSettings` module-private.
   The 100+ typed getters stay authoritative for the legacy path.
4. **Settings are read per-execution, not captured at build time.** The
   platform definitions now resolve settings when a tool executes (from the
   runtime's settings service); the legacy definitions still capture at
   `_buildRuntime`. Per-execution reads are strictly fresher and match the
   legacy getters/defaults exactly (same paths, same defaults, same
   `normalizePath` handling for `shellPath` — reapplied in the bash adapter
   per the Step 1.4 "adapter state stays host-side" decision).
5. **The metadata transport is fully retired for settings.** read/bash no
   longer accept `autoResizeImages`/`commandPrefix`/`shellPath` in options or
   metadata; the recording-service tests assert the settings paths are read
   through the service with empty metadata. `metadata.model` and
   `metadata.extensionContext`/`onUpdate` remain — they are genuine
   per-execution extras with no service equivalent.
6. **Manifests declare the new dependency.** read/bash add `"settings"` to
   `requires.services` and `config: "read"` to `permissions` — `config` is
   the closest `PermissionKey` (the vocabulary has no `settings` key), and the
   declaration passes the same `Value.Parse(CapabilityManifestSchema)` gate.
   Declaration-only, unchanged from prior steps (permissions are not
   enforced).
7. **`SettingsManager.inMemory()` is the boot default.** `ensurePlatformRuntime()`
   callers without a manager (tests, embedding hosts) get a pure in-memory
   manager — no disk I/O, no file locks, safe for a process singleton.
   Production always passes the session's real manager from `createAgentSession`.

## 4. Compromises

1. **The settings service binds to the boot-time manager (one kernel per
   process).** A second `createAgentSession` in the same process keeps the
   first session's manager in the singleton. This is the pre-existing "one
   kernel per process, boot-time workspace root" limitation (Step 1.3 §11.1),
   now visible on a second axis; per-session runtimes stay deferred.
2. **`load`/`save` are approximate mappings.** `load`→`reload()` also clears
   the manager's modified-field tracking; `save`→`flush()` only awaits pending
   writes (there is nothing pending in the skeleton since `set` is not
   implemented). Both are documented and test-covered.
3. **`get` is a plain dotted-path walk.** No array indexing, path escaping, or
   type coercion — sufficient for the pilots' settings
   (`images.autoResize`, `shellCommandPrefix`, `shellPath`).
4. **Settings access is declared via `permissions.config`**, not a dedicated
   settings permission key — the closest fit in the frozen vocabulary.

## 5. Technical Debt (Intentional)

| Debt | Why accepted | Retirement |
| --- | --- | --- |
| `SettingsService` write/observe side throws `NOT_IMPLEMENTED` | Walking skeleton; `SettingsManager` has no generic setter/schema/subscription machinery | Workspaces phase (workspace-scoped configuration needs `set`/`subscribe`) |
| Settings service bound to the process-singleton kernel's boot-time manager | One-kernel-per-process assumption from Step 1.3 | Per-session runtimes / host contracts |
| `metadata.model` / `metadata.extensionContext` / `metadata.onUpdate` transport | No `onUpdate`/session slot in `ToolExecutionContext`; pragmatic bridge | When `ToolExecutionContext` grows proper slots, or when `SessionService` extraction (see §8) takes the session slot |
| `metadata.sessionId` transport in all three consumption adapters | `SessionService` still a stub | Step 1.7 (`SessionService` extraction) |
| Remaining service stubs (session/network/auth/cache/permissions/logging/configuration/telemetry) | Pilots need fs + process + settings only | Replace per service during extraction |
| Per-execution definition construction in all four adapters | Kept deliberately (walking skeleton) | Still not needed; re-evaluate at a fifth capability |
| `packages/platform/dist` must be rebuilt for the running binary | dist is gitignored; release builds it | Release pipeline (`npm run build`) |

## 6. Deferred Functionality (Explicit Non-Goals, Confirmed Unimplemented)

`SettingsService.set`/`registerSchema`/`subscribe`/`subscribeAny`/`reset`/
`getSettingsPath` (see §4/§5), `SessionService` extraction, workspace-scoped
configuration, permission **enforcement** (declaration only), hot
reload/restart, event-bus replay / background-dispatcher roadmap, model
providers, per-session runtimes, host contracts, find/ls migrations, and all
other tool migrations (write/edit stay legacy). No changes to the Step 1.2
event model; no contract gaps surfaced this step — the extraction is entirely
host-side.

## 7. Assumptions

As listed in the design document (§10): the settings service binds to the
boot-time manager (per-session runtimes deferred); dotted-path `get` over the
effective merged snapshot is the right semantics; `load`/`save` mappings are
acceptable for the skeleton; `config: "read"` is the closest declaration of
settings access; the Step 1.2 contracts hold as-is (they did).

## 8. Recommended Next Step

The settings extraction validated that a host-side adapter over an existing
implementation can satisfy a full platform service contract with a minimal
surface, and that capabilities will happily read through `ctx.<service>`
once the transport exists. The same shape now points at the last
metadata-carried piece of per-execution state:

1. **Extract `SessionService` from `SessionManager` the same way.**
   Capabilities still receive `sessionId` only via execution metadata — all
   three consumption adapters (`getPlatform*ToolDefinition`) thread it through
   options into `ToolExecutionContext.sessionId`. A real `SessionService`
   (adapter over `packages/coding-agent/src/core/session-manager.ts`, injected
   at `bootPlatformRuntime` via a new `KernelServiceProviderOptions.session`)
   lets capabilities read `ctx.session` instead. This step must decide the
   session-scoping question this step surfaced: the kernel is a process
   singleton, but a session service is inherently per-session — either the
   service binds to the boot-time manager (documented limitation, as here) or
   the execution path gains a session handle. With settings and session both
   real, the stub surface shrinks to
   network/auth/cache/permissions/logging/configuration/telemetry.
2. Only then (or when a designed feature needs it) extend
   `NodeFileSystemService` with `glob`/`list` for the **find/ls** extraction,
   and add the `GrepOperations` search seam that moves rg behind
   `ProcessService` — completing the read-only tool set on the platform.
3. Workspaces (`docs/WORKSPACE_ARCHITECTURE.md`, roadmap item 3) then has its
   substrate: real settings (configuration), session, fs, and process services,
   and the `set`/`subscribe` side of `SettingsService` lands with it
   (workspace-scoped configuration is the driver for the deferred write side).

The step cadence stays one capability-or-service per step; the adapter
pattern remains, and the definition-factory refactor is deferred until a
fifth capability actually strains it.
