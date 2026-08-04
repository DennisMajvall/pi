# Pi Capability Platform — Runtime Kernel Walking Skeleton: Design Report (Step 1.3)

**Status:** Implemented and validated
**Based on:** `docs/capability-platform/RUNTIME_KERNEL_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

A thin, end-to-end runtime kernel in `@earendil-works/pi-platform/kernel` plus the first migrated capability (`read`) and its consumption wiring in the coding agent.

| Component        | Implementation                                                   | Minimal scope honored                                                                   |
| ---------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Runtime          | `KernelRuntime` (`src/kernel/runtime.ts`)                        | Orchestrates initialize/start/shutdown only                                             |
| Registry         | `KernelCapabilityRegistry`                                       | register/query/exports/state; no hot reload, no persistence                             |
| Discovery        | `BuiltinCapabilityDiscovery`                                     | Static builtin list from the host; source-typed for future sources                      |
| Resolver         | `SimpleCapabilityResolver`                                       | Dependency existence + post-order DFS ordering; no semver, no conflicts                 |
| Loader           | `BuiltinCapabilityLoader`                                        | Factory loading only; no jiti/sandbox/remote/cache                                      |
| Lifecycle        | `KernelLifecycleManager`                                         | init/shutdown, dependency-aware init, reverse-order shutdown; no restart/reload/retries |
| ServiceProvider  | `KernelServiceProvider`                                          | FileSystemService implemented; everything else throws "not implemented"                 |
| EventBus         | `KernelEventBus`                                                 | emit/subscribe/unsubscribe, sync ordered delivery, filters; no replay/history/priority  |
| Pilot capability | `read` (`packages/coding-agent/src/platform/read-capability.ts`) | Adapter over the existing read tool, fs service injected                                |

Pipeline validated end-to-end with the real `read` capability:

```
discovery → registration → resolution → loading → initialization →
exports available → consumed by AgentSession → runtime shutdown → read shutdown
```

## 2. Validation Results

- `packages/platform/test/kernel.test.ts` — **11/11 pass** (pipeline, dependency
  order, reverse shutdown, contexts, fs injection, missing deps, error
  containment, cycles, event bus semantics, registry queries, not-implemented
  services).
- `packages/coding-agent/test/platform-runtime.test.ts` — **6/6 pass** (read
  full lifecycle, execution through service-injected fs, offset/limit, error
  results, adapter builds a working ToolDefinition, fallback when unbooted).
- Existing behaviour: `test/tools.test.ts` (74/74), `test/agent-session-concurrent.test.ts`
  - `test/session-id-readonly.test.ts` (14/14), `test/suite/agent-session-prompt.test.ts`
    (13/13) all pass with the platform wired into the session path.
- Repo-wide `tsgo --noEmit` clean; `biome check` clean on all changed files.

## 3. Architectural Decisions

1. **Kernel lives in `@earendil-works/pi-platform/kernel`**, not a new package.
   The contract subpaths stay implementation-free; `/kernel` is the first
   runtime surface. A separate runtime package can be split out later without
   breaking contract consumers.

2. **Host supplies builtins.** The kernel is generic; the host (coding agent)
   provides the `read` manifest + factory. Discovery is a static list for now,
   but `CapabilitySource`/`CapabilityLoadSpec` keep file/npm/git sources
   addable behind the same interface.

3. **Registry stores state; Lifecycle Manager drives it.** The registry holds
   `RuntimeCapabilityInfo.state` plus internal entry data (loader, exports,
   context, lifecycle); the lifecycle manager mutates through a kernel-only
   state API (`KernelRegistry` extension). This keeps "knows what exists"
   separate from "controls transitions".

4. **Two kernel extensions beyond the Step 1.2 contracts** (documented in the
   design): `KernelRegistry.getContext(id)` (so consumers can build execution
   contexts) and `KernelLifecycleManager.initializeAll()/shutdownAll()` (batch
   drivers for the runtime). No contract interface was broken.

5. **Failure-safe consumption.** `createAgentSession` awaits
   `ensurePlatformRuntime()` (idempotent singleton); `_buildRuntime` sources
   the read definition from registry exports when booted, else falls back to
   the legacy factory. Existing users cannot observe a platform failure.

6. **Adapter over rewrite.** The read capability delegates to the existing
   `createReadToolDefinition`, backing its pluggable `ReadOperations` with the
   platform `FileSystemService`. Two module-level renderers were extracted
   from `read.ts` (behavior-preserving) so the TUI keeps working unchanged.

## 4. Compromises

1. **Process-level singleton runtime.** One kernel per process; per-session or
   per-workspace runtimes are future work. `FileSystemService` is
   cwd-agnostic for absolute paths; `getWorkspaceRoot()` returns the boot-time
   cwd.
2. **`ReadOperations.access` approximates `R_OK`.** The read tool's original
   `access(path, R_OK)` is mapped to `fs.exists` + read; permission-denied
   still surfaces (from the read), just later. Acceptable for the pilot.
3. **`CapabilityManifest` schema/interface drift fixed.** The skeleton exposed
   two real contract gaps: `provides` conflated declarations with runtime
   exports, and the interface lacked `schemaVersion`. Both were corrected in
   the Step 1.2 contracts (schema already had the correct shapes). The event
   model was untouched.
4. **Adapter typing is loose at the boundary.** `buildReadToolDefinition`
   returns `ToolDefinition<any, any>` with casts where the platform tool
   export meets the coding-agent definition (same pattern as the existing
   `tool-definition-wrapper.ts`).
5. **Per-execution definition construction.** The read capability builds a
   read definition per execution (cwd comes from the execution context). Fine
   for a pilot; a proper implementation will bind cwd via a per-session
   capability instance.

## 5. Technical Debt (Intentional)

| Debt                                                                     | Why accepted                   | Retirement                            |
| ------------------------------------------------------------------------ | ------------------------------ | ------------------------------------- |
| Not-implemented service stubs (Proxy throwing on use)                    | Pilot needs only fs            | Replace per service during extraction |
| No manifest schema validation (id/version presence only)                 | Walking skeleton               | TypeBox `Value.Parse` at registration |
| No unregister lifecycle (registry.unregister exists, hot unload doesn't) | Explicit non-goal              | Alongside `LifecycleManager.restart`  |
| Event bus: no replay/history/priority                                    | Explicit non-goal              | Behind the unchanged contract         |
| Process singleton + boot-time workspace root                             | Multi-session not yet designed | Host contracts phase                  |
| The `/kernel` subpath adds runtime behavior to the contracts package     | Pragmatic step                 | Split package when warranted          |

## 6. Deferred Functionality (Explicit Non-Goals, Confirmed Unimplemented)

Host contracts, UI capabilities, RPC runtime, plugin installation, package/git
discovery, marketplace, capability updates, semver conflict handling, advanced
permissions, event replay/persistence, DI framework, service extraction beyond
fs, hot reload, health monitoring, retries.

## 7. Assumptions

As listed in the design document (§11): one runtime per process for now;
registry per runtime instance; fs service cwd-agnostic for absolute paths;
minimal manifest validation; type-only circular contract imports acceptable;
existing session/settings/tool-definition formats are invariants.

## 8. Recommended Next Step

1. **Extract the second capability with real dependencies** (e.g. `bash`,
   which exercises `ProcessService` + permissions, or `edit`, which exercises
   the file-mutation path) to validate dependency edges and a second service.
2. Then begin **service extraction** behind the existing implementations
   (SettingsService from `SettingsManager`, SessionService from
   `SessionManager`) so capabilities stop using stubs.
3. Keep the **pilot-migrate-one-capability-per-step** cadence; the kernel's
   component boundaries held under one real capability, and the next
   capability is the cheapest test of whether they hold under two.
