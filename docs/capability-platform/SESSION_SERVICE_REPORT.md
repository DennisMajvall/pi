# Pi Capability Platform — SessionService Extraction behind SessionManager: Design Report (Step 1.7)

**Status:** Implemented and validated
**Based on:** `docs/capability-platform/SESSION_SERVICE_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

A real `SessionService` adapting the existing `SessionManager`
(`packages/coding-agent/src/core/session-manager.ts`), injected into the
kernel's `KernelServiceProvider` at `bootPlatformRuntime` — the exact shape of
Step 1.6's `SettingsManagerService`. Capabilities now have a session service
behind the `sessionId` they already receive in `ToolExecutionContext`; with
settings and session both real, the stub surface shrinks to
network/auth/cache/permissions/logging/configuration/telemetry.

This step also made and documented the session-scoping decision the previous
report flagged (§3 of the design): the kernel is a process singleton but a
session service is inherently per-session — **the service binds to the
boot-time manager** (the settings precedent), and the execution-path session
handle (a contract change / per-session registry) is deferred to the
Workspaces phase.

| Component | Implementation | Minimal scope honored |
| --- | --- | --- |
| SessionService | `SessionManagerService` (`packages/coding-agent/src/platform/session-service.ts`) | Read surface real: `create` → `SessionManager.create`, `open` → `SessionManager.open`, `list` → `SessionManager.list`, plus the handle's `id`/`cwd`/`workspaceId`/`createdAt`/`updatedAt` getters, `getEntries` (types/since/until/limit/branch filters), `getHeader` (with model/thinkingLevel from the session context), and a no-op `close`. Write surface throws `NOT_IMPLEMENTED`: `fork`/`delete`/`export`/`import` and handle `append`/`updateInfo`. One non-contract accessor, `getBootSession()`, exposes the boot-bound handle so the binding is observable |
| Session handle | `SessionManagerSession` (`session-service.ts`) | Live reads (getters over the manager); workspaceId from `create` options or the session cwd (open) |
| Translation layer | Entry / header / summary mappings (§4.4 of the design) | Manager `custom` and `label` entries omitted (no contract type); `bash_execution` is a contract type the manager never emits; summary `model`/`thinkingLevel`/`entryCount`/`labels` documented as not derivable from `SessionInfo` |
| ServiceProvider | `KernelServiceProviderOptions.session?: SessionService`; constructor wires `options.session ?? not-implemented stub` | Same shape as the `settings` option; default unchanged, so `createRuntime` callers that don't supply a session service keep today's stub behavior |
| Boot wiring | `ensurePlatformRuntime({ settingsManager, sessionManager })`; `bootPlatformRuntime` builds `SessionManagerService(options.sessionManager ?? SessionManager.inMemory())` | `createAgentSession` passes the session's real manager; tests/other callers get a pure in-memory manager; idempotent singleton unchanged |
| SessionManager | **Untouched** — zero additive changes | The adapter uses only the public surface (unlike settings, which needed `getEffectiveSettings()`; `SessionManager` exposes everything the read surface needs) |
| Consumption | `_buildRuntime` unchanged; `ToolExecutionContext.sessionId` threading kept | The frozen per-execution contract field stays filled per AgentSession (§3/§7 of the design); no pilot consumes the session service this step |

## 2. Validation Results

- `packages/coding-agent/test/session-service.test.ts` — **10/10 pass** (new):
  - `create` returns a handle bound to a new session (id matches header, cwd
    honored, workspaceId from options, empty entries, `close()` resolves);
  - `open` reads back a session file with translated entries (ms timestamps,
    contract shapes, parent chain) and header;
  - `list` returns `SessionSummary` for a workspace (temp `PI_CODING_AGENT_DIR`,
    sessions materialized with assistant messages, sorted by `updatedAt`
    desc, workspaceId stamped);
  - `getBootSession()` is bound to the boot-time manager;
  - entry translation: typed entries translated, manager `custom`/`label`
    entries omitted;
  - `getEntries` filters: `types`, `since`/`until` (deterministic timestamps
    via a hand-written v3 file), `limit`, `branch`;
  - `getHeader` reports `model`/`thinkingLevel` from the session context;
  - walking-skeleton scope: `append`/`updateInfo` (handle) and
    `fork`/`delete`/`export`/`import` (service) throw `PlatformError`
    `NOT_IMPLEMENTED`;
  - kernel integration: a supplied `SessionService` is injected through the
    capability context (`ctx.session` is the real service, stub not used).
- `packages/coding-agent/test/platform-runtime.test.ts` — **8/8 pass** (was
  7): new test proves `ensurePlatformRuntime({ sessionManager })` binds the
  booted runtime's session service to that manager (`getBootSession().id`
  matches). The rest are unchanged (the default stays an in-memory manager).
- `packages/platform/test/kernel.test.ts` — **18/18 pass** (was 17): +1 test
  for a supplied `session` override injected through the capability context;
  the "unknown services are not-implemented stubs" test gained a session
  stub assertion (the default is still a stub).
- Existing behaviour unchanged: `test/settings-service.test.ts` (8/8),
  `test/bash-capability.test.ts` (13/13), `test/grep-capability.test.ts`
  (12/12), `packages/platform/test/process-service.test.ts` (18/18),
  `test/tools.test.ts` (74/74), `test/session-id-readonly.test.ts` (7/7),
  `test/agent-session-concurrent.test.ts` (7/7),
  `test/agent-session-dynamic-tools.test.ts` (4/4),
  `test/suite/agent-session-bash-persistence.test.ts` (11/11),
  `test/suite/agent-session-prompt.test.ts` (13/13) all pass — the suite
  harness constructs AgentSession directly, exercising the legacy fallback
  with the session's own `sessionManager`.
- Repo-wide `npm run check` green: biome (990 files), pinned-deps,
  ts-imports, shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke.
- `packages/platform` dist rebuilt (`tsgo -p tsconfig.build.json`) so the
  coding-agent build config and the running binary resolve the new
  `KernelServiceProviderOptions.session` (dist is gitignored; Step 1.4
  precedent).

## 3. Architectural Decisions

1. **The adapter lives in coding-agent, not the platform package.**
   `SessionManager` imports host code (`config.ts`, `utils/paths.ts`,
   `messages.ts`, pi-ai types), so the kernel stays generic and the host
   supplies the implementation through `KernelServiceProviderOptions` —
   exactly the `fs`/`process`/`settings` pattern. The platform package gained
   only the option slot; `SessionManager` itself was **not touched at all**
   (unlike settings, which needed one accessor) — the adapter uses the public
   surface.
2. **Session scoping: bind to the boot-time manager.** The kernel is a process
   singleton but a session service is per-session. Binding (option 1, the
   settings precedent) requires no contract change and keeps the correct
   per-execution identity (`ToolExecutionContext.sessionId`, threaded per
   AgentSession) untouched. Giving the execution path a session handle
   (option 2) would need either a frozen-contract change or a per-session
   registry inside the singleton kernel — session-runtime machinery that
   belongs to the Workspaces phase. Documented limitation: a second
   `createAgentSession` in the same process keeps the first session's manager
   behind `ctx.session`, exactly as it already keeps the first session's
   settings.
3. **Read side real, write side NOT_IMPLEMENTED.** `create`/`open`/`list` and
   the handle's read methods map directly onto `SessionManager`'s public
   surface. The write side is where `SessionManager` is richest, and the
   extraction deliberately does not bridge the contract's generic entry model
   (caller-supplied `id`/`timestamp`/`parentId`, `labels`, `data` blobs) onto
   the manager's typed appenders with **internal** identity generation: every
   contract `SessionEntry` carries identity the manager cannot honor. This is
   the settings `set()` precedent — a generic write would have to replicate
   the host's identity machinery. `updateInfo` falls with it (`labels`/
   `metadata` have no manager equivalent, so honoring only `name` would be a
   partial write). The bridge becomes real when a designed feature drives it
   and the identity question is decided (Workspaces, or a contract alignment).
4. **`getBootSession()` makes the binding observable.** A non-contract
   accessor on the concrete class returns the handle over the boot-time
   manager — the walking skeleton's answer to "which session is the singleton
   service bound to". Nothing in the kernel calls it; tests and future host
   code use it. This also keeps the held manager a live binding seam rather
   than a stored-but-unused field.
5. **Translation is the adapter's main work.** Entries translate to the
   contract's `{ id, type, timestamp: ms, data, parentId }` shape with `data`
   carrying the manager's payload (messages carry the AgentMessage);
   `custom`/`label` entries are omitted (no contract type); the header gains
   `model`/`thinkingLevel` from `buildSessionContext` and drops `parentSession`
   (the contract header has no such field); summaries map `SessionInfo` with
   documented gaps (`model`/`thinkingLevel`/`entryCount`/`labels` are not
   derivable without opening each file). All mappings are test-covered with
   deterministic hand-written fixtures.
6. **`ToolExecutionContext.sessionId` threading stays — it was never the
   debt.** Step 1.6's report listed "metadata.sessionId transport" as debt,
   but inspection shows `sessionId` is a first-class field of the frozen
   per-execution context, correctly filled per AgentSession — the contract's
   designed transport, and the only correct answer to "which session am I"
   given a boot-bound singleton service. The actual gap — no service behind
   the id — is what this step closes. Removing the threading would make the
   context field *less* correct for multi-session processes.
7. **No pilot consumes the service this step.** Unlike settings (read/bash
   read `ctx.settings`), no pilot reads session data, so there is no
   capability-consumption proof to write. The validated deliverables are the
   adapter itself, the kernel injection, and the wiring; consumption lands
   with a designed feature (Workspaces session management, or a context
   capability). The manifests keep `requires.services` without `"session"` —
   declaring a dependency nothing consumes yet would be dishonest.

## 4. Compromises

1. **The session service binds to the boot-time manager (one kernel per
   process).** A second `createAgentSession` in the same process keeps the
   first session's manager behind `ctx.session`. This is the pre-existing
   "one kernel per process, boot-time workspace root" limitation (Step 1.3
   §11.1), now visible on a third axis (settings, workspace root, session);
   per-session runtimes stay deferred.
2. **`WorkspaceId` is interpreted as the project directory path.** Pre-
   Workspaces there is no workspace abstraction; sessions are stored per-cwd,
   so `list(workspaceId)` lists that directory's sessions and the handle's
   `workspaceId` is the `create` option (or the session cwd when opened).
   Documented; the real workspace concept lands with the Workspaces phase.
3. **Summary gaps:** `SessionSummary.model`/`thinkingLevel` are
   `undefined`, `entryCount` is `0`, `labels` is `undefined` — `SessionInfo`
   does not carry them and deriving them would mean opening every session
   file during list (defeating the streaming/concurrent design). Documented.
4. **`create` records only cwd + parentSessionId.** `initialModel`/
   `initialThinkingLevel`/`metadata` are accepted but not recorded — recording
   them is a write, and the write side is deferred. The parentSessionId is
   stored in the header but is not observable through the contract header
   (which has no such field).
5. **`close()` is a no-op** — `SessionManager` holds no open file handles and
   persists synchronously at append time, so there is genuinely nothing to
   release.
6. **`getHeader` derives model/thinkingLevel via `buildSessionContext`**, a
   full session walk — fine for the skeleton, costlier than a header-only
   read would be.

## 5. Technical Debt (Intentional)

| Debt | Why accepted | Retirement |
| --- | --- | --- |
| `SessionService` write surface (`append`/`updateInfo`/`fork`/`delete`/`export`/`import`) throws `NOT_IMPLEMENTED` | Contract's generic entry model vs the manager's typed appenders + internal identity (settings `set()` precedent); no consumer yet | A designed consumer plus identity reconciliation (Workspaces, or a contract alignment) |
| Session service bound to the process-singleton kernel's boot-time manager | One-kernel-per-process assumption from Step 1.3 | Per-session runtimes / host contracts (Workspaces) |
| `WorkspaceId`-as-project-directory interpretation | No workspace abstraction yet | Workspaces phase |
| `SessionSummary` translation gaps (model/thinkingLevel/entryCount/labels) | Not derivable from `SessionInfo` without opening every file | When a consumer needs them (session list UI) |
| `ToolExecutionContext.sessionId` threaded through the three consumption adapters | Frozen per-execution contract field; the boot-bound service cannot answer per-execution identity | Only if the contract grows a per-execution session handle (option 2, §3) |
| Remaining service stubs (network/auth/cache/permissions/logging/configuration/telemetry) | Pilots need fs + process + settings + (now) session only | Replace per service during extraction |
| `packages/platform/dist` must be rebuilt for the running binary | dist is gitignored; release builds it | Release pipeline (`npm run build`) |

## 6. Deferred Functionality (Explicit Non-Goals, Confirmed Unimplemented)

`SessionService.fork`/`delete`/`export`/`import`, `Session.append`/
`updateInfo` (see §3/§5), any pilot consumption of the session service,
per-session runtimes, workspace-scoped session identity, the execution-path
session handle, session export/import formats, and the remaining service
extractions. No changes to the Step 1.2 contracts or event model; no contract
gaps surfaced this step — the extraction is entirely host-side and the
contract surface it touches (create/open/list/handle reads) maps directly.

## 7. Assumptions

As listed in the design document (§9): the session service binds to the
boot-time manager (per-session runtimes deferred); a `WorkspaceId` is its
project directory pre-Workspaces; the contract entry/header/summary data
models translate as specified (host data model rides in `data`); `close()` as
an immediate no-op is honest; no pilot consumes the service this step; the
Step 1.2 contracts hold as-is (they did).

## 8. Recommended Next Step

The session extraction validated the second host-side adapter and retired the
last per-execution-state gap: every service the read-only pilots touch
(fs/process/settings/session) is now real, and the stub surface is down to
network/auth/cache/permissions/logging/configuration/telemetry. The remaining
cheap wins are tool migrations, and the roadmap already names the next one:

1. **Step 1.8 — find/ls + the grep search seam (read-only tool set complete).**
   Extend `NodeFileSystemService` with the `glob`/`list` operations it
   currently throws for, then migrate `find` and `ls` onto the platform as
   `tool.find` / `tool.ls` capabilities (the read/bash/grep adapter pattern),
   and add the `GrepOperations` search seam that routes rg behind
   `ProcessService`. This completes the read-only tool set on the platform —
   the next step after that is the Step 1.10 gate question (making the
   platform the default execution path, not a silent fallback).
2. Workspaces (`docs/WORKSPACE_ARCHITECTURE.md`, roadmap item 3) then has its
   full substrate: settings, session, fs, process, and (from Step 1.8) glob/
   list — and it is the designed home for the deferred session write surface
   (workspace-scoped sessions are the consumer that justifies the generic
   entry bridge) and the per-session runtime scoping this step deferred.

The step cadence stays one capability-or-service per step; the adapter
pattern remains, and the definition-factory refactor is deferred until a
fifth capability actually strains it.
