# Pi Capability Platform — SessionService Extraction behind SessionManager (Step 1.7)

**Status:** Design (pre-implementation)
**Based on:** `docs/SETTINGS_SERVICE_REPORT.md` §8 (recommended next step), `docs/RUNTIME_KERNEL_REPORT.md` §8 (service-extraction roadmap), `docs/CAPABILITY_PLATFORM_CONTRACTS.md` §5.x (SessionService contract), `docs/SETTINGS_SERVICE_DESIGN.md` (Step 1.6 design — the pattern being mirrored)
**Date:** 2026-02-08

---

## 1. Objective

Give the platform a real `SessionService`: an adapter over the existing
`SessionManager` (`packages/coding-agent/src/core/session-manager.ts`),
injected into the kernel's `KernelServiceProvider` at `bootPlatformRuntime` —
the exact shape of Step 1.6's `SettingsManagerService`. This retires the last
service stub the settings report flagged: capabilities currently know the
session only through the bare `sessionId` carried in
`ToolExecutionContext.sessionId`, and there is no service behind that id to
query session state. With settings and session both real, the stub surface
shrinks to network/auth/cache/permissions/logging/configuration/telemetry.

This is still incremental migration, not the finished platform. No building
ahead: the adapter implements the read surface of the contract plus the
session factories; the write surface is deliberately deferred (see §4.3), and
no pilot capability consumes the service this step — the wiring and the
kernel injection are the deliverables, mirroring how Step 1.6's read/bash
consumption proved the settings transport.

## 2. What Stays the Same (from Steps 1.3–1.6)

| Aspect | Status |
|---|---|
| Kernel component boundaries (registry/resolver/loader/lifecycle/service-provider/event-bus) | Unchanged (one additive `session` option in `KernelServiceProviderOptions`) |
| `read`, `bash`, `grep` capabilities and their adapter shape | Unchanged; manifests keep `requires.services` without `"session"` (no pilot consumes it) |
| Step 1.2 contracts (capability/runtime/service/event/error/identifier/schema) | **Frozen** — no contract change this step |
| Event model | Untouched |
| Failure-safe consumption pattern (`ensurePlatformRuntime` + fallback) | Unchanged; `ensurePlatformRuntime` gains an optional `{ sessionManager }` |
| Adapter-over-rewrite pattern (per-execution definition construction) | Kept |
| `AgentSession.executeBash`, extension `ctx.exec`, legacy `createAllToolDefinitions` | Legacy path, untouched |
| Manifest validation at registration (`Value.Parse` against `CapabilityManifestSchema`) | Unchanged — `"session"` is already in the `RequiredService` union |
| `ToolExecutionContext.sessionId` threading in `_buildRuntime` | **Kept** (see §3 and §7 — it is the frozen contract's designed per-execution transport, not debt) |

## 3. The Decision This Step Must Make: session scoping

Step 1.6's report §8 flagged the question this extraction surfaces: the kernel
is a process **singleton**, but a session service is inherently per-session.

Two options:

1. **Bind the service to the boot-time manager** (the settings precedent). The
   singleton service adapts the manager passed to `ensurePlatformRuntime` by
   the first `createAgentSession`. Documented limitation: a second session in
   the same process keeps the first session's manager behind `ctx.session`,
   exactly as it already keeps the first session's settings.
2. **Give the execution path a session handle.** Carry a per-execution session
   object into `ToolExecutionContext`. This requires either a contract change
   (frozen — out of scope) or a per-session registry inside the singleton
   kernel (session-runtime machinery that belongs to the Workspaces phase).

**Decision: option 1 — bind to the boot-time manager.** It matches the
settings precedent exactly, requires no contract change, and the per-execution
identity that *is* correct today (`ToolExecutionContext.sessionId`, threaded
per AgentSession) stays untouched. Option 2 is deferred: it needs per-session
runtimes / a session registry, which the Workspaces phase (roadmap item 3)
is the designed home for.

Because the binding is boot-time, the executing session's identity remains
available the way it already is — `ToolExecutionContext.sessionId` — and the
service answers *session-state* queries against the boot-bound session. For
the common single-session process (one `createAgentSession` per process) the
two are the same session.

## 4. The SessionService Implementation

### 4.1 Location and shape

`packages/coding-agent/src/platform/session-service.ts` (new):

```ts
export class SessionManagerService implements SessionService {
  constructor(manager: SessionManager) { this.manager = manager; }

  async create(options: CreateSessionOptions): Promise<Session> { ... }
  async open(path: string): Promise<Session> { ... }
  async list(workspaceId: WorkspaceId): Promise<SessionSummary[]> { ... }
  fork(...): Promise<Session> { notImplemented("fork"); }
  delete(...): Promise<void> { notImplemented("delete"); }
  export(...): Promise<ExportResult> { notImplemented("export"); }
  import(...): Promise<Session> { notImplemented("import"); }

  /** Host-side accessor: the handle bound to the boot-time manager. */
  getBootSession(): Session { ... }
}
```

- `create` maps to `SessionManager.create(cwd, undefined, { parentSession })`
  and returns a `SessionManagerSession` handle. `initialModel` /
  `initialThinkingLevel` / `metadata` are accepted but **not recorded** in the
  walking skeleton (recording them is a write; the write side is deferred, §4.3).
- `open` maps to `SessionManager.open(path)` and returns a handle.
- `list` maps to `SessionManager.list(cwd)` with the workspaceId interpreted
  as the project directory path (§4.4).
- `fork` / `delete` / `export` / `import` throw `PlatformError`
  `NOT_IMPLEMENTED` (§4.3).
- `getBootSession()` is a **non-contract** accessor on the concrete class
  exposing the boot-bound session handle — the walking skeleton's answer to
  "which session is the singleton service bound to". Nothing in the kernel
  calls it; tests and future host code use it to observe the binding.
- The adapter lives in **coding-agent**, not the platform package, because
  `SessionManager` imports host code (`config.ts`, `utils/paths.ts`,
  `messages.ts`, pi-ai types). The kernel stays generic; the host supplies the
  implementation through `KernelServiceProviderOptions`, exactly like
  `fs`/`process`/`settings`.

### 4.2 The session handle (`SessionManagerSession`)

The contract's `Session` is a handle (not just data):

```ts
class SessionManagerSession implements Session {
  readonly workspaceId: WorkspaceId;   // ctor-injected
  private readonly manager: SessionManager;

  get id(): SessionId { ... }          // manager.getSessionId()
  get cwd(): string { ... }            // manager.getCwd()
  get createdAt(): number { ... }      // header timestamp
  get updatedAt(): number { ... }      // last entry timestamp (getter: stays live)
  async getEntries(options?): Promise<SessionEntry[]> { ... }   // translated
  getHeader(): SessionHeader { ... }   // translated (+ model/thinkingLevel)
  append(...): Promise<void> { notImplemented("append"); }
  updateInfo(...): Promise<void> { notImplemented("updateInfo"); }
  async close(): Promise<void> { /* no-op: the manager holds no open handles */ }
}
```

- `workspaceId` comes from `create`'s options when the session is created, and
  from the session cwd when opened (documented approximation — pre-Workspaces
  a workspace is its project directory).
- `close()` resolves immediately: `SessionManager` keeps no open file handles
  (persistence is synchronous append/write at append time).
- `append` / `updateInfo` throw `NOT_IMPLEMENTED` (§4.3).

### 4.3 Walking-skeleton scope (what stays "not implemented")

| Method | Why deferred |
| --- | --- |
| `fork` | The contract models a fork as a new session from a source handle at an entry; `SessionManager.createBranchedSession` mutates the source manager in place and returns a file path, not a new manager. A faithful non-destructive fork needs per-session runtime machinery (deferred with option 2, §3) |
| `delete` | `SessionManager` has no delete |
| `export` / `import` | `SessionManager` has no export/import (the contract's portable formats are a Workspaces-era feature) |
| `Session.append` | The contract's generic entry model — caller-supplied `id`/`timestamp`/`parentId`, `labels`, `data` blobs — does not fit `SessionManager`'s typed appenders with **internal** id generation and leaf-pointer management. Every contract `SessionEntry` carries identity the manager cannot honor; a generic appender would either lie about it or require changing the manager. This is the settings `set()` precedent: a generic write would replicate the host's identity machinery |
| `Session.updateInfo` | `SessionInfo.name` maps cleanly to `appendSessionInfo`, but `labels`/`metadata` have no manager equivalent. Honoring part of the info object while silently dropping the rest is the same partial-write problem — deferred wholesale |

The write surface is where `SessionManager` is richest, and the extraction
deliberately does not bridge the contract's generic entry model onto the typed
appenders. The bridge becomes real when a designed feature drives it and the
identity question is decided (Workspaces, or a contract alignment).

### 4.4 Translation layer (manager types ↔ contract types)

The contract's data model differs from the manager's (timestamps are numbers,
entries are `{ type, data }` blobs, header has no `parentSession`), so the
adapter translates:

- **Entries** (`getEntries`): manager entry → `{ id, type, timestamp: ms,
  data, parentId }`. `data` carries the manager's entry-specific payload:
  `message` → the AgentMessage; `thinking_level_change` → `{ thinkingLevel }`;
  `model_change` → `{ provider, modelId }`; `compaction` → `{ summary,
  firstKeptEntryId, tokensBefore, details, usage, fromHook }`; `branch_summary`
  → `{ fromId, summary, details, usage, fromHook }`; `custom_message` →
  `{ customType, content, details, display }`; `session_info` → `{ name }`.
  Manager `custom` (extension state) and `label` entries have **no contract
  type** and are omitted. `bash_execution` is a contract type the manager
  never emits (bash runs are `message` entries).
  `GetEntriesOptions` filters are honored: `types` (post-translation),
  `since`/`until` (ms timestamps), `limit`, `branch` (`manager.getBranch`).
- **Header** (`getHeader`): manager header → `{ version, id, cwd, createdAt,
  model?, thinkingLevel? }`. `model`/`thinkingLevel` come from
  `manager.buildSessionContext()` (the manager header itself stores neither);
  `parentSession` is dropped — the contract header has no such field.
- **Summaries** (`list`): `SessionInfo` → `SessionSummary` with `id`/`path`/
  `cwd`/`createdAt`/`updatedAt` mapped and `workspaceId` set to the queried
  workspace id. `model`/`thinkingLevel` are not in `SessionInfo` (deriving
  them requires a per-file context scan — deferred); `entryCount` is not
  derivable either (`SessionInfo` counts messages only), so it is `0`;
  `labels` have no `SessionInfo` equivalent. All three gaps are documented.

The workspaceId→cwd mapping: pre-Workspaces, a workspace is identified by its
project directory, and sessions are stored per-cwd (the default session dir
encodes the cwd), so `list(workspaceId)` lists the sessions whose directory
is that cwd.

## 5. Wiring

### 5.1 `KernelServiceProviderOptions.session`

```ts
// packages/platform/src/kernel/service-provider.ts (additive option)
export interface KernelServiceProviderOptions {
  fs?: FileSystemService;
  process?: ProcessService;
  events?: EventBusService;
  settings?: SettingsService;
  session?: SessionService;   // new
  workspaceRoot?: string;
}
// constructor: this.session = options.session ?? (notImplementedService("session") as SessionService);
```

The default remains the not-implemented stub, so `createRuntime` callers that
don't supply a session service keep today's behavior (kernel tests included).

### 5.2 `bootPlatformRuntime`

```ts
// platform-runtime.ts
export interface PlatformRuntimeOptions {
  settingsManager?: SettingsManager;
  sessionManager?: SessionManager;   // new
}

async function bootPlatformRuntime(options: PlatformRuntimeOptions) {
  const settings = new SettingsManagerService(options.settingsManager ?? SettingsManager.inMemory());
  const session = new SessionManagerService(options.sessionManager ?? SessionManager.inMemory());
  const kernel = createRuntime({
    builtins: [readCapability, bashCapability, grepCapability],
    services: { workspaceRoot: process.cwd(), settings, session },
  });
  ...
}
```

- `SessionManager.inMemory()` is the default when no manager is supplied —
  pure (no disk I/O) and safe for a process singleton.
- `createAgentSession` (sdk.ts) passes the session's real manager:
  `await ensurePlatformRuntime({ settingsManager, sessionManager })`.

### 5.3 `_buildRuntime` — unchanged

The `sessionId` threading stays: `_buildRuntime` still passes
`this.sessionManager.getSessionId()` through the three `getPlatform*ToolDefinition`
options into `ToolExecutionContext.sessionId`. See §7.

## 6. What Stays a Stub / Legacy

| Area | Status |
|---|---|
| `SessionService.fork` / `delete` / `export` / `import`; `Session.append` / `updateInfo` | Not implemented (walking skeleton, §4.3) |
| Remaining stubs (network/auth/cache/permissions/logging/configuration/telemetry) | Unchanged — 7 stubs remain after this step |
| `NodeFileSystemService` beyond read/stat/exists/etc. | Unchanged (`glob`/`list` etc. throw) |
| Permission enforcement | Declaration only |
| Per-session runtimes / workspace-scoped session identity | Deferred (Workspaces) |
| `Session` write bridge (append/updateInfo/fork) | Deferred until a designed consumer + identity reconciliation |
| Other tool migrations (write/edit/find/ls) | Remain legacy |

## 7. Why `ToolExecutionContext.sessionId` Threading Stays

Step 1.6's report listed "metadata.sessionId transport in all three
consumption adapters" as debt for this step. Closer inspection shows the
transport is not metadata: `sessionId` is a **first-class field** of the
frozen `ToolExecutionContext` contract, filled per execution by the
consumption adapters from the executing AgentSession's manager. That is the
contract's designed transport for per-execution identity, and it is correct
even for multi-session processes (each AgentSession builds its own
definitions). The actual gap — no service behind the id — is what this step
closes. Retiring the threading would force the boot-bound singleton service to
answer a per-execution question it cannot answer (the §3 limitation), making
`ToolExecutionContext.sessionId` *less* correct. So the threading stays; the
service is the new query path for session *state*.

## 8. Tests

1. **`test/session-service.test.ts` (new)**
   - `create` returns a handle bound to a new session (id matches header,
     cwd honored, workspaceId from options, entries empty, `close()` resolves);
   - `open` reads back a session file written through a real `SessionManager`
     (entries and header translated: ms timestamps, contract shapes);
   - `list` returns `SessionSummary` for a workspace directory (temp
     `PI_CODING_AGENT_DIR`, sessions materialized with assistant messages,
     sorted by `updatedAt` desc, workspaceId stamped);
   - `getEntries` honors `types`/`since`/`until`/`limit`/`branch` and omits
     manager `custom`/`label` entries;
   - `getHeader` reports `model`/`thinkingLevel` from the session context;
   - walking-skeleton scope: `append`/`updateInfo` (handle) and
     `fork`/`delete`/`export`/`import` (service) throw `PlatformError`
     `NOT_IMPLEMENTED`;
   - `getBootSession()` is bound to the boot-time manager;
   - kernel integration: `createRuntime({ services: { session: service } })`
     injects the service into the capability context (`ctx.session` is the
     real service, stub not used).
2. **`packages/platform/test/kernel.test.ts`** — one new test: a supplied
   `session` override is injected through the capability context; the
   "unknown services are not-implemented stubs" test gains a session stub
   assertion (the default is still a stub).
3. **`test/platform-runtime.test.ts`** — one new test:
   `ensurePlatformRuntime({ sessionManager })` binds the booted runtime's
   session service to that manager (`getBootSession().id` matches);
   existing tests unchanged (default stays in-memory).

## 9. Assumptions

1. One kernel per process; the session service binds to the boot-time manager
   (first `createAgentSession`); per-session runtimes stay deferred (the §3
   decision).
2. Pre-Workspaces, a `WorkspaceId` is its project directory path; `list` and
   handle `workspaceId` follow that interpretation.
3. The contract entry/header data models translate as specified in §4.4; the
   host data model rides in `data` for entries that have one (message payloads
   are the manager's AgentMessage shape).
4. `close()` as an immediate no-op is honest: the manager holds no open
   handles and persistence is synchronous.
5. No pilot consumes the service this step; the kernel injection and wiring
   are the validated deliverables, and consumption lands with a designed
   feature (Workspaces session management, or a context capability).
6. The Step 1.2 contracts hold as-is (they do — the extraction is host-side).
