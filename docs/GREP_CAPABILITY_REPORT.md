# Pi Capability Platform — Third Capability (grep) + First Peer-Capability Dependency: Design Report (Step 1.5)

**Status:** Implemented and validated
**Based on:** `docs/GREP_CAPABILITY_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

The third migrated capability (`grep`, after `read` and `bash`) — and the
platform's **first capability with a peer-capability dependency**
(`requires.capabilities: ["tool.read"]`). No new service was implemented;
grep is backed by the existing `FileSystemService` plus the read capability
as a peer. The Step 1.4 walking skeleton was untouched in structure; grep
traverses the same pipeline with the peer edge exercised for real.

| Component | Implementation | Minimal scope honored |
| --- | --- | --- |
| Peer-capability dependency | `grepManifest.requires.capabilities: [{ id: "tool.read", version: "*" }]` | First use of the `requires.capabilities` edge: resolver post-order DFS, dependency-aware init order, reverse-order shutdown |
| Peer consumption | grep's `init(ctx)` reads `tool.read`'s exports via `ctx.capabilities.getExports` and backs `GrepOperations.readFile` with them | Real peer use, not a declared-but-dead dependency |
| Additive read export | `read-capability.ts` exports `readTextFile(path)` (no-truncation text read via `ctx.fs.readBytes`) | `CapabilityExports` is arbitrary, so no Step 1.2 contract change; existing consumers read only `exports.tool` |
| Pilot capability | `grep` (`packages/coding-agent/src/platform/grep-capability.ts`) | Adapter over the existing `createGrepToolDefinition`; `GrepOperations.isDirectory` via the injected `FileSystemService.stat`, `readFile` via the read peer |
| Consumption | `getPlatformGrepToolDefinition(cwd, { sessionId })` in `platform-runtime.ts`; `_buildRuntime` sources grep from the registry with a legacy fallback | Same failure-safe shape as read/bash |
| Manifest validation | The grep manifest passes the same `Value.Parse(CapabilityManifestSchema, ...)` gate | `requires.capabilities` entries validated as `CapabilityDependencySchema` |
| `grepSchema` export | `tools/grep.ts` now exports `grepSchema` (was module-private, unlike `readSchema`/`bashSchema`) | Additive; needed for discovery metadata |

## 2. Validation Results

- `packages/coding-agent/test/grep-capability.test.ts` — **12/12 pass**:
  - lifecycle with peer dep: read and grep both `Ready`, grep's manifest
    declares `requires.capabilities` with `tool.read`, `read.loadedAt <=
    grep.loadedAt` (dependency-aware init order), both `Unloaded` after
    reverse-order shutdown;
  - **hard dependency**: registering grep alone lands it in `Error` state
    with a clear message ("grep capability requires the read capability")
    — the resolver records the missing dependency without crashing;
  - the read capability's `readTextFile` primitive is exported and returns
    full file contents;
  - real execution: file search with matches, cwd-relative `path: "."`,
    correct context lines **for a match at line 2500 of a 3000-line file**
    (a truncating read — the read tool's execute path — cannot produce this,
    so it proves `readFile` uses the peer's full-content read), and error
    results (`Path not found`, `No matches found`);
  - **peer delegation spy**: a stub `tool.read` capability records every
    `readTextFile` call; grep's context-line reads go through it;
  - runtime co-boot: `ensurePlatformRuntime()` boots read + bash + grep all
    `Ready` (grep's peer is satisfied by the same builtins list);
  - consumption adapter: undefined when unbooted (fallback), working
    `ToolDefinition` with `renderCall`/`renderResult`, error propagation.
- Existing behaviour unchanged: `test/platform-runtime.test.ts` (6/6),
  `test/bash-capability.test.ts` (13/13), `test/tools.test.ts` (74/74),
  `test/session-id-readonly.test.ts` (7/7), `test/agent-session-concurrent.test.ts`,
  `test/agent-session-dynamic-tools.test.ts`,
  `test/suite/agent-session-bash-persistence.test.ts` (11/11),
  `test/suite/agent-session-prompt.test.ts` (13/13) all pass.
- `packages/platform/test/kernel.test.ts` (16/16) and
  `test/process-service.test.ts` (18/18) pass (no platform changes this
  step).
- Repo-wide `npm run check` green: biome (986 files), pinned-deps,
  ts-imports, shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke.

## 3. Architectural Decisions

1. **grep, not find/ls.** `GrepOperations` maps to already-implemented
   `NodeFileSystemService` methods (`stat`, `readBytes`); find would need
   `fs.glob` and ls would need `fs.list`, both currently "not implemented".
   grep is the only one of the three with a natural peer relationship (it
   reads file contents; read is the file-reading capability). Extending the
   fs service is deferred to whichever extraction actually needs it.
2. **The peer dependency is consumed, not decorative.** grep's `readFile`
   delegates to the read capability's exported `readTextFile`, captured at
   init through `ctx.capabilities.getExports`. The read tool's own
   `execute` applies `truncateHead` (2000 lines / 50KB), which would corrupt
   context blocks for matches deep in large files, so grep must not route
   through it — hence the additive `readTextFile` primitive on the read
   capability. The deep-match test (line 2500 of 3000) proves the full-read
   path.
3. **Peer deps are hard.** `requires.capabilities` is non-optional in the
   manifest; a missing peer fails the dependent's init with a clear error
   (registry `Error` state, resolver `missing` record — no crash). This is
   the honest semantic of a hard dependency and the first real-capability
   exercise of the resolver's missing-dep path.
4. **The rg search process stays in the tool.** `GrepOperations` covers only
   the file side of grep; the tool spawns `rg` via `node:child_process` on
   both legacy and platform paths. Unlike bash (whose `BashOperations.exec`
   seam covered the whole process lifecycle), moving the search behind a seam
   would be a rewrite of `tools/grep.ts` — out of scope for an adapter step.
5. **`readTextFile` is a host-package convention**, not a platform contract
   item: both capabilities live in `packages/coding-agent/src/platform/`,
   and `CapabilityExports` is arbitrary. The Step 1.2 contracts are
   untouched this step.
6. **A design-doc claim was corrected during implementation:** the design
   assumed `grepSchema` was already exported from `tools/grep.ts` (like
   `readSchema`/`bashSchema`); it was module-private. The export is now
   additive, mirroring the other two tools.
7. **The consumption adapter pattern still holds at three capabilities.**
   Per-execution definition construction caused no friction for grep; the
   "definition-factory refactor" remains unnecessary (Step 1.4 report §8,
   item 3 stays deferred).

## 4. Compromises

1. **grep's search backend is not platform-injected.** The rg process is
   spawned by the tool itself (see decision 4). The platform path differs
   from the legacy path only on the file side (directory check + context
   reads).
2. **Peer failure is a hard error, not a fallback.** If `tool.read` is ever
   removed from the builtins while grep stays, the runtime boot fails and the
   failure-safe fallback (legacy definitions) engages — grep does not degrade
   to direct fs reads on its own. This is deliberate (honest manifest), but
   it means the peer edge is load-bearing.
3. **`compatibility.peers` stays empty**; the peer version constraint rides
   in `requires.capabilities[].version` (`"*"`), which the resolver currently
   ignores. Semver resolution is still deferred.

## 5. Technical Debt (Intentional)

| Debt | Why accepted | Retirement |
| --- | --- | --- |
| grep's rg spawn stays host-side (`node:child_process`) | `GrepOperations` has no search seam; moving it is a tool rewrite | Add a `search` operation seam to `GrepOperations` and back it with `ProcessService` |
| `readTextFile` primitive is a host-side convention | Peer edge needs a real, no-truncation API; contracts frozen | Promote to a platform contract item when tool-to-tool consumption is formalized |
| `NodeFileSystemService.glob` / `list` still stubs | find/ls not migrated | Alongside find/ls extraction |
| `metadata.extensionContext` / `metadata.onUpdate` transport | No `onUpdate` slot in `ToolExecutionContext`; pragmatic bridge | When `ToolExecutionContext` grows a proper callback/session slot, or when `SettingsService` replaces the metadata settings transport (see §8) |
| Per-execution definition construction in all three adapters | Kept deliberately (walking skeleton; read/bash precedent) | Still not needed; re-evaluate at a fourth capability |
| Remaining service stubs (settings/session/network/auth/cache/permissions/logging/configuration/telemetry) | Pilots need fs (+ read peer) only | Replace per service during extraction |
| `packages/coding-agent/dist` must be rebuilt for the running binary | dist is gitignored; release builds it | Release pipeline (`npm run build`); tests run against src via vitest aliases |

## 6. Deferred Functionality (Explicit Non-Goals, Confirmed Unimplemented)

Permission **enforcement** (`permissions: { fs: "read" }` is declaration
only; `PermissionService` remains a stub), hot reload/restart, event-bus
replay / background-dispatcher roadmap, model providers, per-session
runtimes, host contracts, find/ls migrations, and all other tool migrations
(write/edit stay legacy). No changes to the Step 1.2 event model; no contract
gaps surfaced this step.

## 7. Assumptions

As listed in the design document (§6): the rg search stays host-side;
peer consumption is a hard dependency; `readTextFile` is a host-package
convention; `compatibility.peers` stays empty; one kernel per process;
the Step 1.2 contracts hold as-is (they did).

## 8. Recommended Next Step

The peer edge held under real use, and the adapter pattern still causes no
friction at three capabilities. The kernel's own recommendation chain (Step
1.4 report §8, item 2) now points at the remaining structural gap, and it is
the one `docs/features-to-implement.md`'s foundational roadmap needs before
the first downstream designed feature (Workspaces):

1. **Extract `SettingsService` behind the existing `SettingsManager`.**
   Today `read` (`autoResizeImages`) and `bash` (`commandPrefix`,
   `shellPath`) ride their settings through execution metadata, and grep has
   none. A real `SettingsService` implementation (an adapter over
   `packages/coding-agent/src/core/settings-manager.ts`, injected into the
   kernel's `KernelServiceProvider` at `bootPlatformRuntime`, following the
   `NodeProcessService` precedent) lets capabilities read settings through
   `ctx.settings.get(...)` instead of the metadata bridge — retiring the
   `metadata.extensionContext`/`metadata.onUpdate`-adjacent transport debt
   and giving the platform its first config-bearing service. This is the
   cheapest extraction: no tool migration required, and it is the substrate
   Workspaces (`docs/WORKSPACE_ARCHITECTURE.md`, features-to-implement #3)
   needs for workspace-scoped configuration.
2. Then extract **`SessionService` from `SessionManager`** the same way
   (capabilities currently get `sessionId` only via execution metadata), and
   with both real services the kernel's stub surface shrinks to
   network/auth/cache/permissions/logging/configuration/telemetry.
3. Only then (or when a designed feature needs it) extend
   `NodeFileSystemService` with `glob`/`list` for the **find/ls** extraction,
   and consider the `GrepOperations` search seam that would move rg behind
   `ProcessService` — completing the read-only tool set on the platform.

The step cadence stays one capability-or-service per step; the adapter
pattern remains, and the definition-factory refactor is deferred until a
fourth capability actually strains it.
