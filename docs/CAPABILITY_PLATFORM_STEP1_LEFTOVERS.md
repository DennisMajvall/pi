# Capability Platform (ROADMAP Step 1) — Leftovers & Debt Inventory

**Status:** Compilation + **code-verified** (Part 3 items confirmed against source).
**Purpose:** Collect every leftover, deferred/"do-later" item, compromise, worry, and
piece of intentional technical debt from the Step 1 reports, then deduplicate them into a
single master list so the codebase is checked against each open item exactly once.
**Source documents:** all eight Step 1 design reports in `docs/capability-platform/`
(Steps 1.3–1.10). No report exists for Step 1.2 (contracts) — see "Coverage note" below.

> **Read-me caveat:** **Part 3 has since been code-verified** (each M-item checked against
> the `packages/platform` and `packages/coding-agent` source, see Part 7). The reports'
> retirement paths and "current status" were originally taken from the reports' own text;
> verification confirmed each is still true, corrected the ones that are not (notably M5:
> the event bus is now a real minimal implementation, not a stub), and rated every item
> for roadmap timing. Items marked RETIRED in Part 4 are **not** re-checked.

---

## Coverage note

- ROADMAP item 1 (Capability Platform) is Steps 1.2–1.10. Reports exist for **1.3, 1.4,
  1.5, 1.6, 1.7, 1.8, 1.9, 1.10** (8 reports).
- **Step 1.2 (contracts package) has no standalone report.** Its real content lives
  inside the RUNTIME_KERNEL report, which tells us the contracts *were* corrected in
  flight (the schema-versus-runtime-export drift and missing `schemaVersion` were fixed
  during Step 1.3). Any leftover attributed to "the Step 1.2 contracts" therefore rides
  on later steps and is captured below, but a contracts-regression check has no dedicated
  source document — worth noting so it does not get silently re-scoped.
- The reports are the honest record: every step lists its *compromises*, *intentional
  technical debt*, and *deferred non-goals* explicitly. Items marked in the reports as
  RETIRED during a later step are tracked at the bottom under "already retired" so they
  are not re-checked.

---

## Part 1 — Raw inventory by report

Each entry is tagged with its source step and section (C = compromise, D = debt,
DF = deferred non-goal, A = assumption, RN = recommended-next-step).

### RUNTIME_KERNEL_REPORT (1.3)
- R1.3-C1 Process-level singleton runtime; per-session/per-workspace runtimes are future
  work. `FileSystemService` is cwd-agnostic for absolute paths; `getWorkspaceRoot()`
  returns the boot-time cwd.
- R1.3-C2 `ReadOperations.access` approximates `R_OK` via `fs.exists` + read;
  permission-denied surfaces later, from the read itself.
- R1.3-C4 Adapter typing is loose at the boundary (`ToolDefinition<any, any>` with casts).
- R1.3-C5 Per-execution definition construction (cwd comes from the execution context).
- R1.3-D1 Not-implemented service stubs (Proxy throwing on use), retire per service.
- R1.3-D2 No manifest schema validation (id/version presence only). → RETIRED in 1.4.
- R1.3-D3 No unregister lifecycle (registry.unregister exists, hot unload doesn't).
- R1.3-D4 Event bus: no replay/history/priority.
- R1.3-D5 Process singleton + boot-time workspace root.
- R1.3-D6 `/kernel` subpath adds runtime behavior to the contracts package; split package
  when warranted.
- R1.3-DF Host contracts; UI capabilities; RPC runtime; plugin installation; package/git
  discovery; marketplace; capability updates; semver conflict handling; advanced
  permissions; event replay/persistence; DI framework; service extraction beyond fs; hot
  reload; health monitoring; retries.

### BASH_CAPABILITY_REPORT (1.4)
- R1.4-C1 `ProcessHandle.exited` resolves `-1` for signal-killed processes.
- R1.4-C2 Direct `node:child_process` spawn (no cross-spawn); `.bat`/`.cmd` Windows
  resolution out of scope.
- R1.4-C3 `ExecOptions.maxBuffer` ignored; `exec` collects unbounded output.
- R1.4-C5 Windows kill via `taskkill` is fire-and-forget; `exited` races the OS kill.
- R1.4-D1 `ProcessService.spawnPty` still a stub (PTY feature phase).
- R1.4-D2 `exec`/`shell` unbounded output (maxBuffer ignored).
- R1.4-D3 Per-execution definition construction in the bash capability.
- R1.4-D4 `metadata.extensionContext` / `metadata.onUpdate` transport (no `onUpdate` slot
  in `ToolExecutionContext`).
- R1.4-D5 One kernel per process, boot-time workspace root.
- R1.4-D6 `packages/platform/dist` must be rebuilt for the running binary.
- R1.4-D7 Remaining service stubs (settings/session/network/auth/cache/permissions/
  logging/configuration/telemetry).
- R1.4-DF Permission **enforcement** (declaration only); hot reload/restart; event-bus
  replay/background-dispatcher; model providers; per-session runtimes; host contracts;
  write/grep/find/ls/edit migrations.

### GREP_CAPABILITY_REPORT (1.5)
- R1.5-C1 grep's rg search backend is not platform-injected (tool spawns `rg` itself).
  → RETIRED in 1.8 (search seam).
- R1.5-C2 Peer failure is a hard error, not a fallback; the grep→read peer edge is
  load-bearing.
- R1.5-C3 `compatibility.peers` stays empty; the peer version constraint rides in
  `requires.capabilities[].version` ("*"), which the resolver currently ignores. Semver
  resolution deferred.
- R1.5-D2 `readTextFile` primitive is a host-side convention; promote to a platform
  contract item when tool-to-tool consumption is formalized.
- R1.5-D3 `NodeFileSystemService.glob`/`list` still stubs. → RETIRED in 1.8.
- R1.5-D4 `metadata.extensionContext` / `metadata.onUpdate` transport; settings transport
  to be retired via SettingsService. (Settings half → RETIRED in 1.6.)
- R1.5-D5 Per-execution definition construction; re-evaluate at a fourth capability.
- R1.5-D6 Remaining service stubs.
- R1.5-D7 `packages/coding-agent/dist` rebuild for the running binary.
- R1.5-DF Permission enforcement; hot reload; event-bus replay/background-dispatcher;
  model providers; per-session runtimes; host contracts; find/ls; write/edit.

### SETTINGS_SERVICE_REPORT (1.6)
- R1.6-C1 Settings service binds to the boot-time manager (one kernel per process).
- R1.6-C2 `load`/`save` are approximate mappings (`load`→`reload()` also clears the
  manager's modified-field tracking; `save`→`flush()` only awaits pending writes).
- R1.6-C3 `get` is a plain dotted-path walk (no array indexing, path escaping, coercion).
- R1.6-C4 Settings access declared via `permissions.config`, not a dedicated settings key.
- R1.6-D1 `SettingsService` write/observe side throws `NOT_IMPLEMENTED`
  (`set`/`registerSchema`/`subscribe`/`subscribeAny`/`reset`/`getSettingsPath`).
- R1.6-D2 Settings service bound to the process-singleton kernel's boot-time manager.
- R1.6-D3 `metadata.model` / `metadata.extensionContext` / `metadata.onUpdate` transport.
- R1.6-D4 `metadata.sessionId` transport in the consumption adapters. (Resolved in 1.7:
  threading is the designed contract transport, not debt.)
- R1.6-D5 Remaining service stubs.
- R1.6-D6 Per-execution definition construction.
- R1.6-D7 `packages/platform/dist` rebuild.
- R1.6-DF `set`/`registerSchema`/`subscribe`/`subscribeAny`/`reset`/`getSettingsPath`;
  SessionService extraction; workspace-scoped configuration; permission enforcement; hot
  reload; event-bus replay; model providers; per-session runtimes; host contracts;
  find/ls; write/edit.

### SESSION_SERVICE_REPORT (1.7)
- R1.7-C1 Session service binds to the boot-time manager (third axis of the one-kernel
  limitation).
- R1.7-C2 `WorkspaceId` interpreted as the project directory path (pre-Workspaces).
- R1.7-C3 Summary gaps: `SessionSummary.model`/`thinkingLevel`/`entryCount`/`labels` not
  derivable from `SessionInfo` (would mean opening every file during list).
- R1.7-C4 `create` records only cwd + parentSessionId; `initialModel`/
  `initialThinkingLevel`/`metadata` accepted but not recorded.
- R1.7-C5 `close()` is a no-op.
- R1.7-C6 `getHeader` derives model/thinkingLevel via `buildSessionContext` (full session
  walk, costlier than a header-only read).
- R1.7-D1 `SessionService` write surface (`append`/`updateInfo`/`fork`/`delete`/
  `export`/`import`) throws `NOT_IMPLEMENTED`; generic entry identity reconciliation
  deferred.
- R1.7-D2 Session service bound to the process-singleton kernel's boot-time manager.
- R1.7-D3 `WorkspaceId`-as-project-directory interpretation.
- R1.7-D4 `SessionSummary` translation gaps.
- R1.7-D5 `ToolExecutionContext.sessionId` threaded through the adapters; boot-bound
  service cannot answer per-execution identity.
- R1.7-D6 Remaining service stubs.
- R1.7-D7 `packages/platform/dist` rebuild.
- R1.7-DF `fork`/`delete`/`export`/`import`; `append`/`updateInfo`; any pilot consumption
  of the session service; per-session runtimes; workspace-scoped session identity;
  execution-path session handle; session export/import formats; remaining service
  extractions.

### FIND_LS_SEARCH_SEAM_REPORT (1.8)
- R1.8-C1 Platform find path is not fd: `.gitignore` awareness and `--hidden` are fd
  features on the legacy path; behavior is documented, not silently different.
- R1.8-C2 Exit-code normalization is implicit (`null` legacy-killed vs `-1`
  platform-killed both pass the same guards).
- R1.8-C3 Platform glob is a plain minimatch walk, not fd-fast; performance belongs to the
  eventual Workspaces indexing step.
- R1.8-C4 find/ls adapters ride `sessionId` through execution metadata.
- R1.8-D1 Platform find lacks `.gitignore`/`--hidden` (fd parity); retirement is a
  gitignore-aware glob mode or fd-backed search behind a `FindOperations` variant.
- R1.8-D2 `NodeFileSystemService` write surface still stubs. → RETIRED in 1.9.
- R1.8-D3 grep/find/ls `sessionId` rides execution metadata.
- R1.8-D4 Per-execution definition construction in all five adapters.
- R1.8-D5 Remaining service stubs (includes events).
- R1.8-D6 `packages/platform/dist` rebuild.
- R1.8-DF Permission enforcement; hot reload; event-bus replay/background-dispatcher;
  model providers; per-session runtimes; host contracts; write/edit; `.gitignore`-aware
  glob; fd parity; Step 1.10 gate.

### WRITE_EDIT_MIGRATION_REPORT (1.9)
- R1.9-C1 Edit adapter's `access` probes writability but not readability (a mode-0222 file
  passes the probe and fails later at `readFile` with raw `EACCES`).
- R1.9-C2 `move` is plain `fs.rename` — no cross-device (EXDEV) copy fallback.
- R1.9-C3 Platform write path has no transactionality beyond the tools' own.
- R1.9-C4 write/edit adapters ride `sessionId` through execution metadata.
- R1.9-D1 `permissions.fs: "write"` is declaration only — `PermissionService` stub.
- R1.9-D2 `fs.move` has no EXDEV fallback.
- R1.9-D3 `NodeFileSystemService.watch` stub (event-system territory).
- R1.9-D4 Remaining service stubs.
- R1.9-D5 Per-execution definition construction remains (now via the shared helper).
- R1.9-D6 `packages/platform/dist` rebuild.
- R1.9-DF Permission enforcement; hot reload; event-bus replay; model providers;
  per-session runtimes; host contracts; `.gitignore` glob; fd parity; write/edit tool
  rewrites (they are adapters); Step 1.10 gate.

### CAPABILITY_PLATFORM_GATE_REPORT (1.10)
- R1.10-C1 A genuinely broken single tool now takes the whole set to legacy (atomicity
  trades per-tool degradation for coherence).
- R1.10-C2 The granular `getPlatformXToolDefinition` accessors remain (test/host-only).
- R1.10-C3 The fallback is still a full legacy tool set, including the legacy paths'
  settings-capture semantics (gate inverts sourcing; does not port the settings transport).
- R1.10-D1 `permissions.fs: "write"` (and read-side declarations) are declaration only —
  `PermissionService` stub.
- R1.10-D2 `fs.move` no EXDEV; `NodeFileSystemService.watch` stub; remaining service stubs
  (network/auth/cache/events/permissions/logging/configuration/telemetry).
- R1.10-D3 The seven granular `getPlatformXToolDefinition` accessors are now test/host-only.
- R1.10-D4 Per-execution definition construction remains (each capability builds a fresh
  definition per call via `executePlatformTool`).
- R1.10-D5 `packages/platform/dist` rebuild.
- R1.10-DF Permission enforcement; hot reload; event-bus replay/background dispatcher;
  model providers; per-session runtimes; host contracts; remaining service stubs; any
  Planning/Workspaces/Event-System work (designed, not started).

---

## Part 2 — Deduplication pass (which raw entries merged)

| Master item | Merged from |
| --- | --- |
| M1 Singleton runtime / boot-bound services | R1.3-C1,D5 · R1.4-D5 · R1.6-C1,D2 · R1.7-C1,D2 (+ "one kernel per process" in every report) |
| M2 Per-execution session identity / session handle | R1.6-D4 · R1.7-D5 · R1.8-C4,D3 · R1.9-C4 (the `sessionId` threading thread, reframed as designed transport in 1.7) |
| M3 metadata transport (extensionContext / onUpdate / model) | R1.4-D4 · R1.5-D4 · R1.6-D3 |
| M4 Per-execution definition construction | R1.3-C5 · R1.4-D3 · R1.5-D5 · R1.6-D6 · R1.8-D4 · R1.9-D5 · R1.10-D4 |
| M5 Remaining service stubs | R1.3-D1 · R1.4-D7 · R1.5-D6 · R1.6-D5 · R1.7-D6 · R1.8-D5 · R1.9-D4 · R1.10-D2 |
| M6 Permission enforcement deferred | R1.4-DF · R1.5-DF · R1.8-DF · R1.9-D1 · R1.10-D1 |
| M7 Settings write side | R1.6-C2 · R1.6-D1 · R1.6-DF |
| M8 Session write side + identity reconciliation | R1.7-D1 · R1.7-DF |
| M9 Session translation gaps | R1.7-C3 · R1.7-D4 |
| M10 Session create records gaps | R1.7-C4 |
| M11 Session minor reads (close, getHeader cost) | R1.7-C5 · R1.7-C6 |
| M12 WorkspaceId-as-path | R1.7-C2 · R1.7-D3 |
| M13 ProcessService edge semantics | R1.4-C1,C2,C3,C5 · R1.4-D1,D2 · R1.8-C2 |
| M14 Access/permission probing approximate | R1.3-C2 · R1.9-C1 |
| M15 fd parity / glob performance | R1.5-C3(semver only partially) · R1.8-C1,C3,D1 · R1.8-DF |
| M16 readTextFile host-side convention | R1.5-D2 |
| M17 Atomicity / bulk fallback | R1.5-C2 · R1.10-C1,C3 |
| M18 Granular accessors test/host-only | R1.10-C2 · R1.10-D3 |
| M19 Event-bus replay/persistence + watch stub | R1.3-D4 · every report's event-bus non-goal · R1.9-D3 |
| M20 Hot reload / restart / hot-unload lifecycle | R1.3-D3 · every report's hot-reload non-goal |
| M21 Semver resolution / compatibility.peers | R1.3-DF(semver) · R1.5-C3 |
| M22 Distribution/discovery/RPC/DI/health/retry scope | R1.3-DF (RPC, plugin install, package/git discovery, marketplace, capability updates, UI capabilities, DI, health monitoring, retries) |
| M23 Model providers | every report's non-goal |
| M24 Host contracts phase | every report's "host contracts" non-goal + R1.10-C2 retirement path |
| M25 /kernel subpath split | R1.3-D6 |
| M26 dist rebuild for running binary | R1.4-D6 · R1.5-D7 · R1.6-D7 · R1.7-D7 · R1.8-D6 · R1.9-D6 · R1.10-D5 |
| M27 Adapter boundary typing (`any`) | R1.3-C4 · R1.10-decision-6 |
| M28 Settings read-semantics (dotted-path, config key) | R1.6-C3 · R1.6-C4 |

---

## Part 3 — Merged master list (the single list to verify against code)

Grouped by theme. Each item: what to check, source steps, and named retirement/owner.

### A. Runtime scoping — the "one kernel per process" limitation
- **M1 — Singleton runtime, boot-bound workspace root and boot-bound settings/session
  services.** One `KernelRuntime` per process; `getWorkspaceRoot()` is the boot-time cwd;
  a second `createAgentSession` in the same process keeps the *first* session's
  `SettingsManager` and `SessionManager` behind `ctx.settings` / `ctx.session`. Facets to
  check: per-session and per-workspace runtimes do not exist; fs is cwd-agnostic for
  absolute paths only; the boot-bound manager binding is visible on three axes
  (workspace root, settings, session).
  Retirement: **not a Workspaces item.** The Workspaces design
  (`docs/WORKSPACE_ARCHITECTURE.md` §12a; see also `docs/RUNTIME_MODEL.md`) builds on, not against, the single-kernel
  model and explicitly does not deliver per-session runtimes; it only scopes
  per-execution cwd to `Workspace.root`. This is a separate runtime-scoping /
  host-contracts item, designed after Workspaces, which decides per-service whether
  session-scoped (settings, session) or process-scoped (fs/process/WorkspaceManager).
  The older reports' blanket "retirement: per-session runtimes / host contracts
  (Workspaces)" is optimistic; correct attribution is *host-contracts,
  post-Workspaces*. Sources: 1.3, 1.4, 1.6, 1.7.

### B. Session identity
- **M2 — No per-execution session handle; `sessionId` is threaded through all seven
  adapters.** `ToolExecutionContext.sessionId` is the contract's designed transport and
  is filled per AgentSession (not itself debt), but the boot-bound session service cannot
  answer per-execution identity. The only open question is whether a per-execution
  session handle / per-session registry is ever added.
  Retirement: Workspaces / per-session runtimes, or the contract grows a session slot.
  Sources: 1.6, 1.7, 1.8, 1.9.

### C. Execution-metadata transport bridge
- **M3 — `metadata.extensionContext` / `metadata.onUpdate` / `metadata.model` ride the
  tool definition metadata.** bash's streaming `onUpdate` callback, read's model-shaped
  `extensionContext`, and `metadata.model` are carried as per-execution extras because
  `ToolExecutionContext` has no proper `onUpdate`/session/callback slots. Check these
  still exist and where they'd move.
  Retirement: when `ToolExecutionContext` grows proper slots; settings half already
  retired in 1.6. Sources: 1.4, 1.5, 1.6.

### D. Tool-set construction
- **M4 — Each capability builds a fresh definition + operations per execution.** Even
  after the try/catch dedup (`executePlatformTool`) and the generic builder
  (`buildPlatformToolDefinition`), construction happens per call with execution-time cwd
  and injected operations. Check whether shared/persistent definitions are ever warranted.
  Retirement: re-evaluate when hosts need shared definitions. Sources: every step.
- **M17 — Atomicity vs bulk fallback.** A booted kernel missing any one of the seven
  tool exports triggers a loud warning and a *wholesale* legacy fallback; a genuinely
  broken single tool now takes the whole set to legacy (no per-tool degradation). The
  grep→read peer edge is load-bearing (removing read while grep stays fails the boot).
  Check: the single `??` decision point in `resolveBaseToolDefinitions`; the "all seven or
  none" rule; the warning on partial registry.
  Sources: 1.5, 1.10.
- **M18 — Granular `getPlatformXToolDefinition` accessors are now test/host-only.** The
  seven accessors share the generic builder but are no longer used by the session.
  Check whether they are truly only used by tests/hosts (they were kept rather than
  removed). Source: 1.10.
- **M27 — Adapter boundary typing is `any`.** `ToolDefinition<any, any>` /
  `AgentToolResult<any>` casts at the platform↔coding-agent boundary (same as the
  pre-existing wrapper). Check it is confined to the boundary. Sources: 1.3, 1.10.

### E. Service layer
- **M5 — Remaining kernel service stubs.** After `fs` (both sides), `process`,
  `settings`, `session` became real, the stubs still throwing are:
  `network`, `auth`, `cache`, `permissions`, `logging`, `configuration`, `telemetry`.
  **Correction (verified): `events` is no longer a stub** — the booted runtime always
  injects a real `KernelEventBus` (`emit`/`subscribe`/`subscribeAll`, sync ordered
  delivery); only replay/history remain missing, which is M19, not a stub. The seven
  listed above still throw `NOT_IMPLEMENTED` from `KernelServiceProvider`.
  Sources: every step.
- **M6 — Permission enforcement is declaration-only.** All `permissions` declarations
  (`fs: read/write`, `process: spawn`, `config: read`) are declaration only;
  `PermissionService` is a stub; nothing is enforced. Check that no enforcement snuck in
  and that the declarations are still honest.
  Retirement: Approval Framework / policies. Sources: 1.4–1.10.
- **M7 — SettingsService write/observe side throws `NOT_IMPLEMENTED`.** `set`,
  `registerSchema`, `subscribe`, `subscribeAny`, `reset`, `getSettingsPath` still throw;
  workspace-scoped configuration deferred. Read side (`get`/`getAll`/`load`/`save`) is
  real. Retirement: Workspaces. Source: 1.6.
- **M28 — Settings read semantics are minimal.** `get` is a plain dotted-path walk (no
  array indexing, path escaping, coercion); settings access is declared via
  `permissions.config` rather than a dedicated settings key. Sources: 1.6.
- **M8 — SessionService write surface throws `NOT_IMPLEMENTED`.** `append`/`updateInfo`
  (handle) and `fork`/`delete`/`export`/`import` (service) all throw; the generic
  contract entry model + internal identity reconciliation is deferred. Check whether any
  write method was added. Retirement: Workspaces / contract alignment. Source: 1.7.
- **M9 — Session translation gaps.** `SessionSummary.model`/`thinkingLevel` are
  `undefined`, `entryCount` is `0`, `labels` is `undefined` (not derivable from
  `SessionInfo`); header `parentSession` is dropped; manager `custom`/`label` entries are
  omitted; `bash_execution` is a contract type the manager never emits.
  Retirement: when a consumer needs them (session-list UI). Source: 1.7.
- **M10 — `Session.create` records only cwd + parentSessionId.** `initialModel`,
  `initialThinkingLevel`, `metadata` are accepted but not recorded. Source: 1.7.
- **M11 — Session read minor cases.** `close()` is a no-op (nothing to release);
  `getHeader` derives model/thinkingLevel via a full `buildSessionContext` session walk
  (costlier than a header-only read). Source: 1.7.
- **M12 — `WorkspaceId` is interpreted as the project directory path** (pre-Workspaces);
  `list(workspaceId)` lists that directory's sessions. Retirement: Workspaces. Source: 1.7.
- **M13 — ProcessService edge semantics.** `ProcessHandle.exited` resolves `-1` for
  signal-killed processes; Windows kill via `taskkill` is fire-and-forget (`exited` races
  the OS kill); `.bat`/`.cmd` resolution is out of scope (direct child_process, no
  cross-spawn); `exec`/`shell` collect unbounded output (`maxBuffer` ignored);
  `spawnPty` still throws `NOT_IMPLEMENTED`; exit-code normalization between the legacy
  `null` and platform `-1` is implicit. Sources: 1.4, 1.8.
- **M14 — Access / permission probing is approximate.** `read` adapts the original
  `access(R_OK)` to `fs.exists` + read (permission-denied surfaces late); `edit`'s
  `access` probes writability but not readability (a mode-0222 file fails later at
  `readFile` with a raw `EACCES` rather than the nice "Could not edit file" message).
  Sources: 1.3, 1.9.

### F. FileSystemService gaps
- **M15 — No fd parity / gitignore-aware glob; glob is not fd-fast.** Platform find
  ignores only the explicit `node_modules`/`.git` list and the standard dotfile rule;
  `.gitignore` awareness and `--hidden` remain legacy-fd features. The glob is a plain
  minimatch walk (not performance-tuned); performance belongs to Workspaces indexing.
  Check the documented "Respects .gitignore" tool description is still only accurate on
  the legacy/fallback path. Sources: 1.5, 1.8.
- **M16 — `readTextFile` on the read capability is a host-side convention**, not a
  contract item (the tool-to-tool consumption precedent). Retirement: promote to a
  platform contract when tool-to-tool consumption is formalized. Source: 1.5.
- **M19-fs — `fs.move` has no EXDEV fallback** (plain `fs.rename`); `NodeFileSystemService.watch`
  still throws `NOT_IMPLEMENTED`. EXDEV retirement: Workspaces; watch: Event System.
  Sources: 1.9, 1.10.

### G. Event system
- **M19 — Event bus has no replay/history/priority/persistence; background dispatcher
  deferred.** The kernel event bus is sync ordered delivery + filters only. Event
  persistence / replay / background-subscriber roadmap is deferred to the Event System
  feature. Sources: every step; concrete stub: `fs.watch` (1.9).

### H. Kernel lifecycle / registry / distribution scope (explicit non-goals)
- **M20 — No hot reload / restart / hot unload.** `registry.unregister` exists but there
  is no hot unload; no `LifecycleManager.restart`.
- **M21 — No semver resolution / conflict handling.** `compatibility.peers` stays empty;
  the peer version constraint rides in `requires.capabilities[].version` ("*") and the
  resolver ignores versions; `conflicts` not evaluated.
- **M22 — Distribution/discovery/marketplace/RPC scope.** No RPC runtime, plugin
  installation, package/git/npm discovery, capability marketplace, capability updates,
  UI capabilities, DI framework, health monitoring, or retries (all explicit non-goals of
  the platform build; several map to later roadmap items, e.g. marketplace #13).
- **M25 — `/kernel` subpath puts runtime behavior in the contracts package.** Candidate
  for a separate runtime package split when warranted. Source: 1.3.
- **M23 — Model providers deferred.**
- **M24 — Host contracts phase deferred** (owns per-session runtimes, host API replacing
  the granular accessors). Source: every step.

### I. Build / release process
- **M26 — `packages/platform/dist` (and `coding-agent/dist`) must be rebuilt manually for
  the running binary.** dist is gitignored; tests resolve from src via vitest aliases;
  the release pipeline builds it. Check no committed-dist drift is expected. Sources:
  every step from 1.4.

---

## Part 4 — Already retired (confirmed done in a later step; NOT re-checked)

These were named debt/compromises in an earlier report and explicitly retired by a later
step. Listed here so the master list above does not double-count them.

- Manifest schema validation (`R1.3-D2`) → retired 1.4 (TypeBox `Value.Parse`).
- rg search staying host-side (`R1.5-C1`) → retired 1.8 (real `GrepOperations.search`
  seam backed by `ProcessService`).
- `fs.glob`/`fs.list` stubs (`R1.5-D3`) → retired 1.8.
- `fs` write-surface stubs (`R1.8-D2`) → retired 1.9 (`write`/`append`/`delete`/`mkdir`/
  `copy`/`move` real).
- Settings metadata transport (`autoResizeImages`/`commandPrefix`/`shellPath`) → retired
  1.6 (reads go through `ctx.settings`).
- `metadata.sessionId` called "debt" (`R1.6-D4`) → reframed 1.7 as a designed contract
  transport, not debt (see M2).
- Seven `buildXToolDefinition` adapter duplication → retired 1.9 (`executePlatformTool`)
  then 1.10 (generic `buildPlatformToolDefinition`).
- Manifest↔tool description drift → retired 1.10 (sourced from templates + fixture).

---

## Part 5 — Bugs to be careful not to re-introduce while checking

- **1.3 C3:** the manifest schema/runtime-export conflation and missing `schemaVersion`
  were fixed during 1.3 — if the contracts were re-opened, verify these flags did not
  regress.
- **1.7 D? translation:** the entry/header/summary translations are the adapter's main
  surface; when checking M9, confirm translations still match the documented mappings.
- **1.9 C3:** the platform write path intentionally adds *no* transactionality beyond the
  tools' own queue — do not flag absence as a regression.

---

## Part 6 — Documentation gaps to keep in mind

- **No report for Step 1.2 (contracts).** If a contracts-level audit is wanted, the
  source is the RUNTIME_KERNEL report's *in-flight* corrections, not a dedicated step
  document. Contracts themselves are complete per the gate report.
- Every step names its "Recommended Next Step"; the chain terminates at Planning
  (`docs/PLANNING_ARCHITECTURE.md`). None of these are open leftovers but they are the
  sanctioned continuation and are the retirement home for several items above
  (M2, M7, M8, M12, M15).
- **M1 correction (see Part 3, item A):** Worktrees/Workspaces do **not** fix the
  single-kernel/boot-bound-service limitation. That is a separate runtime-scoping item
  (host contracts, post-Workspaces), called out in `docs/RUNTIME_MODEL.md` (and
  `docs/WORKSPACE_ARCHITECTURE.md` §12a).
  The other parallel-execution roadmap items are also **not** M1's home: Event System,
  Background Workers, Task/Execution Engine, and SubAgents are all *in-process*
  coordination on the single kernel (Axis C in `docs/RUNTIME_MODEL.md`), not runtime scoping. M1 (Axis A)
  is currently unowned and stays deferred — it is a **human decision gate** (option
  menu + pros/cons, host-model-dependent, bias toward the smallest implementation that
  is good enough) to be resolved only when a concrete multi-session-in-one-process host
  requirement appears (`docs/RUNTIME_MODEL.md`).

---

## Part 7 — Code verification results & roadmap timing (authoritative)

Every M-item above was checked against the source during this pass. This section records
(a) whether it is still a live concern, (b) how urgent it is, and (c) which roadmap step
is its retirement home, if any. **Per the prioritization rule: nothing here is fixed in
isolation — each item is resolved as part of the roadmap step that owns it. Only items
required "for the next step" (Workspaces, then Event System) are acted on when that step
starts; everything else is scheduled for its later owner or deprioritized.**

Priority tiers:

- **NEXT** — owned by / required for the next roadmap steps (Planning, Workspaces, Event
  System); resolves when that step is built.
- **LATER** — owned by a specific later roadmap item; resolved when that item is built.
- **NICE** — nice-to-have / polish; no current consumer; actively deprioritized. Low
  hanging fruit beats heavy work, so among these the cheap ones get done first.
- **KEEP** — verified fine / intentional / not a concern; no action.

| # | Verified status (source) | Still a concern? | Where it lives | Tier |
|---|--------------------------|------------------|----------------|------|
| **M1** | One `KernelRuntime` + `ServiceProvider` per process; `getWorkspaceRoot()` = boot-time cwd; boot-bound settings/session (`KernelServiceProvider` defaults, `NodeProcessService`, `runtime.ts`). No per-session/per-workspace runtime. | Yes, but by design | **No roadmap item owns it.** Axis A (runtime scoping). Documented in `docs/RUNTIME_MODEL.md` (+ `docs/WORKSPACE_ARCHITECTURE.md` §12a). Human decision gate, conditional on a concrete multi-session-in-one-process host. | **Deferred (human gate)** |
| **M2** | `sessionId` threaded per-execution via `PlatformToolSetOptions` → `buildPlatformToolDefinition` → `tool.execute` (`platform-runtime.ts`); boot-bound `SessionManagerService.getBootSession()` cannot answer per-execution identity. | Open question only (a per-exec session handle) | Workspaces (per-execution cwd/session handle) | **NEXT (Workspaces)** |
| **M3** | `metadata` carries `model` (read) and `extensionContext`/`onUpdate` (bash) because `ToolExecutionContext` has no slots (`platform-runtime.ts`). | Yes (latent) | Contract evolution / host-contracts phase (when `ToolExecutionContext` grows slots) | **NICE** |
| **M4** | Each capability's exported `execute` builds a fresh definition per call (`read/bash/...capability.ts`), `buildPlatformToolDefinition` per tool-set build. | Yes (latent; shared defs only matter if hosts need reuse) | Re-evaluate when a host needs persistent/shared definitions | **NICE** |
| **M5** | Verified: `network`, `auth`, `cache`, `permissions`, `logging`, `configuration`, `telemetry` still throw `NOT_IMPLEMENTED` from `KernelServiceProvider`. **`events` corrected: no longer a stub** (real `KernelEventBus`). | Partially — stubs are by design until a consumer | permissions→Approval Framework (11)/Policies (14); logging+telemetry→Observability (12); network/auth/cache→model providers/marketplace (13)/memory | **LATER** |
| **M6** | `permissions: { fs: read/write, process: spawn, config: read }` are declaration-only; `PermissionService` throws. No enforcement anywhere. | Yes | Approval Framework (11) + Policies (14) | **LATER** |
| **M7** | `SettingsService.set/registerSchema/subscribe/subscribeAny/reset/getSettingsPath` throw `NOT_IMPLEMENTED` (`settings-service.ts`); read side (`get/getAll/load/save`) real. | Yes | Workspaces (workspace-scoped configuration) | **NEXT (Workspaces)** |
| **M8** | `SessionService` write surface throws: `append`/`updateInfo` (handle) and `fork`/`delete`/`export`/`import` (service) (`session-service.ts`). | Yes | Workspaces (session write + identity); fork/export/import also serve Subagents (8) | **NEXT (Workspaces)** |
| **M9** | `toSessionSummary` hard-sets `model`/`thinkingLevel`/`labels` to `undefined`, `entryCount: 0`; `bash_execution`/`custom`/`label` entries omitted (`session-service.ts`). | Yes (only when a consumer lists sessions) | Consumer-driven: session-list UI / Observability (12) | **NICE** |
| **M10** | `Session.create` records cwd + parentSessionId only; `initialModel`/`initialThinkingLevel`/`metadata` accepted, not recorded (`session-service.ts`). | Yes | Consumer-driven: Observability (12), plan/session list | **NICE** |
| **M11** | `close()` is a no-op **(this is correct** — persistence is synchronous, nothing to release); `getHeader` does a full `buildSessionContext` walk (costlier than header-only read). | `close` not a concern; `getHeader` perf only | Perf polish; no current consumer | **NICE** |
| **M12** | `WorkspaceId` treated as the project directory path: `list(workspaceId)` lists that cwd's sessions; opened session's workspace = its cwd (`session-service.ts`). | Yes — will be replaced | Workspaces (real `WorkspaceId`) | **NEXT (Workspaces)** |
| **M13** | `exited` resolves `-1` for signal-killed; `taskkill` fire-and-forget; `.bat`/`.cmd` out of scope; `exec`/`shell` ignore `maxBuffer` (unbounded collection); `spawnPty` throws; exit `null` vs `-1` normalization implicit (`process-service.ts`). | Yes (mostly edge cases) | `maxBuffer` = cheap safety win; `spawnPty` when interactive PTY needed; others documented | **NICE** (maxBuffer = low hanging fruit) |
| **M14** | read `access` = `fs.exists` only (R_OK approximated); edit `access` probes writability via append, not readability (mode-0222 fails later with raw `EACCES`) (`read-capability.ts`, `edit-capability.ts`). | Yes (polish) | Polish when touched; not blocking | **NICE** |
| **M15** | glob is a plain minimatch walk (explicit `node_modules`/`.git` ignore + dotfile rule only); no `.gitignore` awareness / `--hidden`; find description says "Respects .gitignore" (accurate only on legacy path) (`fs-service.ts`). | Yes | fd parity + gitignore-aware glob + perf → Workspace Indexing (10); doc-hygiene note applies now | **LATER (Indexing 10)** |
| **M16** | `readTextFile` is a host-side additive export (cast `ReadTextFileExport`), not a contract item (`read-capability.ts`); grep consumes it (`grep-capability.ts`). | Yes (only when tool-to-tool consumption formalized) | Promote to platform contract when the peer-export form is formalized | **NICE** |
| **M17** | Verified: single `??` in `resolveBaseToolDefinitions`; atomic "all seven or none"; loud warning on partial registry (`platform-runtime.ts`). | No — accepted tradeoff, by design | Keep; note per-tool degradation as a possible future refinement (not needed) | **KEEP** |
| **M18** | Seven `getPlatformXToolDefinition` accessors exist, used by tests/hosts only; session consumes the atomic set (`platform-runtime.ts`). | No — intentional | Keep until host-contracts phase supplies a host API (M24); then reconsider | **KEEP** |
| **M19** | Event bus is real but minimal: sync ordered emit/subscribe; `getHistory` returns `[]`, `replay` option throws (`event-bus.ts`); `fs.watch` throws (`fs-service.ts`). | Yes | Event System (4): replay/history/persistence + background dispatcher; `fs.watch` also feeds Automation/Indexing (10/17) | **NEXT (Event System)** |
| **M20** | `registry.unregister` exists but no hot unload of a running capability; `LifecycleManager.restart` throws `NOT_IMPLEMENTED` (`lifecycle.ts`). | Yes | No owner; hot reload is a later operational concern | **NICE** |
| **M21** | `SimpleCapabilityResolver` ignores versions; `checkConflicts` returns `[]`; peer version rides `requires.capabilities[].version` ("*") (`resolver.ts`). | Yes | Marketplace (13) / capability updates + semver resolution | **LATER (Marketplace 13)** |
| **M22** | No RPC, plugin install, package/git/npm discovery, marketplace, capability updates, UI caps, DI, health monitoring, retries (`BuiltinCapabilityDiscovery` static). | Yes (non-goals) | Marketplace (13); RPC/UI/host → host-contracts phase (M24) | **LATER** |
| **M23** | No platform model-provider layer. | Yes (non-goal) | Not an M-item in practice; model providers are an ai-package/host concern | **Deferred** |
| **M24** | Host contracts phase deferred (owns per-session runtimes, host API replacing granular accessors = M1/M18). | Yes (non-goal) | Post-Workspaces, human-driven (see M1) | **Deferred (human gate)** |
| **M25** | `/kernel` subpath carries runtime behavior; contract subpaths stay implementation-free (`kernel/index.ts`). | Yes (latent) | Split the runtime package when it grows (host-contracts phase) | **NICE** |
| **M26** | `dist/` is gitignored; release pipeline builds it; no committed-dist drift (`packages/*/dist`). | No — documented behavior | None | **KEEP** |
| **M27** | `ToolDefinition<any, any>` / `AgentToolResult<any>` casts at the platform↔coding-agent boundary (`platform-runtime.ts`, `tool-execution.ts`). | Yes (type hygiene) | Tighten when the boundary contracts are formalized | **NICE** |
| **M28** | `get` is a plain dotted-path walk (no array indexing/path escaping/coercion); settings declared via `permissions.config` (`settings-service.ts`, `read-capability.ts`). | Yes (only when config needs it) | Workspaces (workspace-scoped config) / when dotted-path arrays are needed | **NICE** (partly NEXT with Workspaces) |

### When to act (goal-oriented, not implementation detail)

- **Do nothing now beyond what Steps 2–4 need.** The only items that must be in place as
  their owning feature is built:
  - **Workspaces (item 3) absorbs:** M2 (per-execution identity handle), M7
    (workspace-scoped settings write/observe), M8 (session write for workspace sessions),
    M12 (real `WorkspaceId` replaces path-as-id). These are not standalone fixes — they
    fall out of the Workspaces design (see `docs/WORKSPACE_ARCHITECTURE.md` §12).
  - **Event System (item 4) absorbs:** M19 (replay/history/persistence + `fs.watch`).
    This is the feature itself, already designed (`docs/EVENT_ARCHITECTURE.md`).
- **Leave for later roadmap items** (do not front-load): M5 stubs, M6 permissions
  (Approval Framework/Policies), M9/M10 (Observability), M15 fd/gitignore glob
  (Indexing), M21/M22 (Marketplace), M16 (contract phase).
- **Deprioritize (nice-to-have, may never be needed):** M3, M4, M11(getHeader), M13, M14,
  M20, M25, M27, M28, M23, M24. Among these, prefer the cheap ones first (M13 `maxBuffer`,
  M14 access polish) over the heavy ones (M3/M4 contract rework). M1 is a deliberate
  human decision gate — do **not** resolve it until a multi-session-in-one-process host
  requirement appears.
- **Keep as-is (do not touch):** M17 (atomic wholesale fallback), M18 (granular
  accessors for test/host), M26 (dist rebuild via release pipeline).

### Corrections this pass made to the master list

- **M5:** removed `events` from the stub list — the booted runtime injects a real
  `KernelEventBus` (minimal emit/subscribe); only replay/history remain missing (M19).
- **M11:** `close()` being a no-op is not a bug (persistence is synchronous); only the
  `getHeader` full-walk cost is a real (perf) concern.
