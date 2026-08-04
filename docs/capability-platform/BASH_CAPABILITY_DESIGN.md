# Pi Capability Platform — Second Capability (bash) + ProcessService Extraction (Step 1.4)

**Status:** Design (pre-implementation)
**Based on:** `docs/capability-platform/RUNTIME_KERNEL_REPORT.md` §8 (recommended next step), `docs/capability-platform/RUNTIME_KERNEL_DESIGN.md` (kernel ownership), `docs/CAPABILITY_PLATFORM_CONTRACTS.md` (Step 1.2 contracts)
**Date:** 2026-02-08

---

## 1. Objective

Migrate the `bash` builtin tool onto the capability platform as the **second**
migrated capability (after `read`), and implement the platform's
`ProcessService` — currently a not-implemented stub — as the **first real
service extraction beyond `FileSystemService`**.

This validates that the Step 1.3 migration pattern generalizes across a second
service boundary, and it builds the `ProcessService` foundation the designed
Workspaces, Subagents, and Background Workers features depend on (the Workspace
manager runs git, etc.).

The kernel's component boundaries held under one real capability; the cheapest
test of whether they hold under two is a second capability with a **real
service dependency** (`requires.services: ["process"]`) — bash exercises both
the dependency edge and a second service implementation.

This is still incremental migration, not the finished platform. No building
ahead.

---

## 2. What Stays the Same (from Step 1.3)

| Aspect | Status |
|---|---|
| Kernel component boundaries (registry/resolver/loader/lifecycle/service-provider/event-bus) | Unchanged |
| `read` capability and its consumption wiring | Unchanged |
| Step 1.2 contracts (capability/runtime/service/event/error/identifier/schema) | **Frozen** — modified only if the implementation surfaces a genuine gap, and then documented |
| Event model | Untouched |
| Failure-safe consumption pattern (`ensurePlatformRuntime` + fallback) | Extended to bash, same shape |
| Adapter-over-rewrite pattern (per-execution definition construction) | Kept; no "definition factory" refactor in this step |
| `AgentSession.executeBash` and extension `ctx.exec` | Legacy path, untouched |

---

## 3. ProcessService Contract Mapping

The Step 1.2 `ProcessService` contract
(`packages/platform/src/service/index.ts`) and what the bash pilot needs via
the `BashOperations.exec` seam:

| `ProcessService` method | Implemented | Used by bash pilot | Notes |
|---|---|---|---|
| `spawn(command, args, options) → ProcessHandle` | Yes | Yes | The only method the bash adapter calls. Full implementation: node:child_process spawn, Web-Stream stdio, signal-abort and timeout kill (process tree), robust exit wait. |
| `exec(command, args, options) → Promise<ExecResult>` | Yes | No | Convenience over `spawn` (collect stdout/stderr). Kept for the next extraction (Workspaces runs git via exec). |
| `shell(command, options) → Promise<ExecResult>` | Yes | No | `exec` through a shell binary (`-c`). Convenience for future hosts. |
| `kill(pid, signal?)` | Yes | No | Kills a tracked process (and its tree). Throws NOT_FOUND for untracked pids. |
| `getProcess(pid) → ProcessInfo` | Yes | No | Info for processes spawned by this service instance. |
| `spawnPty(...)` | No | No | Throws "not implemented", mirroring `NodeFileSystemService`. |

### 3.1 Mapping decisions

- **Streaming**: `BashOperations.exec` streams output via `onData(Buffer)`; the
  contract's `exec`/`shell` return collected strings. Therefore the bash adapter
  uses `ProcessService.spawn` and pumps the `ProcessHandle.stdout/stderr` Web
  Streams into `onData`. `exec`/`shell` exist for completeness and are built on
  the same spawn.
- **Timeout units**: `BashOperations.exec` receives seconds (tool schema);
  `SpawnOptions.timeout`/`ExecOptions.timeout` are milliseconds. The bash
  adapter converts (same `resolveTimeoutMs` bounds as the legacy path); the
  kernel treats its timeout options as milliseconds.
- **Kill semantics**: killing a process in this service kills its **process
  tree** (POSIX process-group SIGKILL, Windows `taskkill /F /T`). Rationale: a
  shell's descendants are its command; killing only the shell would orphan
  running commands. This matches the behavior of the legacy
  `createLocalBashOperations` (which calls `killProcessTree` on abort/timeout).
- **Exit wait**: `ProcessHandle.exited` resolves like the legacy
  `waitForChildProcess`: on `close`, or after `exit` when the stdio pipes end,
  or after a 100ms idle grace (re-armed on output) so detached descendants
  holding pipes cannot hang the caller and tail output is not lost. This ports
  the pi#5303 fix into the kernel.
- **Spawn errors**: a spawn failure (e.g. ENOENT for a missing shell binary)
  rejects `exited`, exactly like the legacy wait rejects.
- **`ProcessHandle.exited` type**: the contract says `Promise<number>`; a
  signal-killed process has no exit code, so the kernel resolves `-1` in that
  case (documented; matches `ExecResult.exitCode` mapping).

---

## 4. The bash Capability

### 4.1 Manifest

Static declaration (discovery without loading), registered alongside `read`:

```ts
{
  schemaVersion: 1,
  id: "tool.bash",
  version: "1.0.0",
  category: "tool",
  provides: { tool: { name: "bash", description, parameters: bashSchema,
                      promptSnippet, promptGuidelines } },
  requires: { services: ["process"], capabilities: [] },
  permissions: { process: "spawn" },          // declaration only, no enforcement
  compatibility: { runtime: ">=0.83.0", peers: {} },
  metadata: { name: "Bash Tool", description, tags: ["builtin", "process"] },
}
```

`bashSchema` is exported from `tools/bash.ts` (additive export; no logic
change) so discovery metadata carries the real parameter schema, mirroring how
`read` uses `readSchema`.

### 4.2 Factory adapter

Same shape as the `read` capability:

1. `init()` builds a **template** definition (`createBashToolDefinition("")`)
   for metadata (name/description/parameters/prompt snippet/guidelines).
2. The exported `tool.execute(args, toolCtx)`:
   - reads `commandPrefix` / `shellPath` from `toolCtx.metadata` (the same
     settings mechanism read uses for `autoResizeImages`);
   - builds `BashOperations` backed by `toolCtx.capability.process` (the
     injected `ProcessService`) plus `toolCtx.capability.fs` for the
     working-directory existence check;
   - builds a **per-execution** definition with the execution `cwd` +
     `{ operations, commandPrefix, shellPath }` (identical adapter pattern to
     read; no definition-factory refactor);
   - executes it and maps the result/error into `ToolResult`.
3. `shutdown()` is a no-op (nothing to release in the pilot).

### 4.3 ProcessService-backed `BashOperations`

The adapter's `exec(command, cwd, { onData, signal, timeout, env })`:

1. Resolve the shell via `getShellConfig(shellPath)` (existing helper).
2. Verify `cwd` exists via the injected `FileSystemService` — throws the exact
   legacy message `Working directory does not exist: <cwd>\nCannot execute bash commands.`
3. Pre-check `signal.aborted` → throw `aborted`.
4. Convert `timeout` (seconds) to ms with the legacy bounds.
5. `process.spawn(shell, args, { cwd, detached: platform !== "win32", env,
   stdio: [stdin? "pipe" : "ignore", "pipe", "pipe"], signal })` — the
   `signal` is passed through so the kernel kills the process tree on abort
   (the adapter needs no abort listener of its own).
6. When the shell takes the command via stdin, write it to `handle.stdin` and
   close.
7. Pump `handle.stdout`/`handle.stderr` (Web Streams) into `onData(Buffer)`.
8. Own timeout timer: on fire, `handle.kill()` (tree) + flag.
9. `await handle.exited`; then map:
   - `signal.aborted` → throw `aborted` (tool renders "Command aborted");
   - timeout flag → throw `timeout:<seconds>` (tool renders "Command timed out
     after N seconds");
   - else return `{ exitCode }`.
10. Cleanup in `finally`: clear the timer, cancel readers.

This keeps **all bash logic in the existing tool** (accumulator, truncation,
rendering, error formatting, session-env resolution) untouched; only the
process backend moves from `node:child_process` (in `createLocalBashOperations`)
to the platform `ProcessService`.

### 4.4 Session environment

`createBashToolDefinition`'s `execute` resolves the spawn environment through
`resolveSpawnContext(..., exposeSessionEnvironment, ctx)` using the
`ExtensionContext`. The consumption adapter passes the **real** `ExtensionContext`
through execution metadata (`metadata.extensionContext`), so the platform-built
definition sets `PI_SESSION_ID`/`PI_PROVIDER`/`PI_MODEL` etc. exactly like the
legacy definition. (The read adapter already passes function-bearing objects —
the model — through metadata, so this follows precedent.) When the extCtx is
absent (some RPC paths), `resolveSpawnContext` already guards on `ctx` being
undefined.

### 4.5 Live output updates

`createBashToolDefinition` streams partial output through the `onUpdate`
callback. The platform `ToolExecutionContext` has no `onUpdate` slot, so the
consumption adapter forwards it via `metadata.onUpdate` (same transport as
`extensionContext`). Final output and rendering are otherwise identical.

---

## 5. Consumption Wiring

`_buildRuntime` in `agent-session.ts` gains the bash twin of the read wiring:

```ts
const platformBash = getPlatformBashToolDefinition(this._cwd, {
  commandPrefix: shellCommandPrefix,
  shellPath,
  sessionId: this.sessionManager.getSessionId(),
});
if (platformBash) baseToolDefinitions.bash = platformBash;
```

`getPlatformBashToolDefinition(cwd, options)` in `platform-runtime.ts`:

1. Returns `undefined` when the kernel is not booted (fallback stays intact).
2. Reads the `tool.bash` exports + context from the registry.
3. Builds a coding-agent `ToolDefinition<any, any>` (the contract boundary,
   same loose typing as read):
   - metadata from the capability's `definition`;
   - `execute` delegating to `tool.execute` with a `ToolExecutionContext`
     (capability context, signal, sessionId, cwd, metadata carrying
     commandPrefix/shellPath/extensionContext/onUpdate);
   - `renderCall`/`renderResult` taken from a template
     `createBashToolDefinition("")` (bash's renderers are object methods on the
     definition; unlike read they were never extracted as module functions, and
     the template avoids touching bash.ts).

`executeBash` and extension `ctx.exec` remain on the legacy path — only the
tool **definition** is sourced from the platform.

---

## 6. Manifest Validation Hardening

`KernelCapabilityRegistry.register` currently checks only id/version presence.
This step validates the full manifest with TypeBox `Value.Parse` against
`CapabilityManifestSchema` at registration time:

```ts
try {
  Value.Parse(CapabilityManifestSchema, manifest);
} catch (error) {
  throw new PlatformError("Capability manifest failed schema validation", {
    code: "VALIDATION_ERROR",
    metadata: { manifestId: manifest.id, details: ... },
  });
}
```

- Invalid manifests are rejected with a `VALIDATION_ERROR` PlatformError
  (surfacing the TypeBox error details) instead of being registered.
- Both the `read` and `bash` manifests must pass; kernel test fixtures are
  schema-conformant already.

---

## 7. What Stays a Stub

| Area | Status |
|---|---|
| `ProcessService.spawnPty` | Throws "not implemented" |
| Other services (settings/session/network/auth/cache/permissions/logging/configuration/telemetry) | Unchanged not-implemented stubs |
| Permission enforcement | Declaration only (`permissions: { process: "spawn" }`); `PermissionService` remains a stub |
| Hot reload / restart / unregister lifecycle | Not implemented |
| Event-bus replay / background-dispatcher roadmap | Not implemented |
| Model providers, per-session runtimes, host contracts | Not implemented |
| Other tool migrations (write/grep/find/ls/edit) | Remain legacy |

---

## 8. Ownership

| Concern | Owner | Notes |
|---|---|---|
| Process execution (spawn/stream/kill/exit-wait) | `NodeProcessService` (kernel) | Generic; no bash knowledge |
| Shell resolution, cwd check, timeout conversion, error strings | bash capability adapter (host) | Bash-specific glue, mirrors `createLocalBashOperations` |
| Tool logic (accumulator/truncation/rendering/session env) | `createBashToolDefinition` | Untouched |
| Registry/state/lifecycle | Kernel components | Unchanged from Step 1.3 |
| Manifest validation | `KernelCapabilityRegistry.register` | `Value.Parse` at registration |

---

## 9. Assumptions

1. `NodeProcessService` spawns with `node:child_process` directly (no
   cross-spawn); the bash shell on Windows is a real executable resolved by
   `getShellConfig`, so `.bat`/`.cmd` resolution is out of scope for the pilot.
2. `SpawnOptions.env` values are strings; `NodeJS.ProcessEnv`-shaped objects
   are accepted via a narrow cast (Node tolerates `undefined` values).
3. `maxBuffer` (`ExecOptions`) is ignored in the skeleton; `exec` collects
   output unboundedly.
4. Processes spawned by one `NodeProcessService` instance are tracked in that
   instance only; `kill(pid)`/`getProcess(pid)` address those.
5. One kernel per process (unchanged); the bash capability uses the singleton
   `ProcessService` through the capability context.
6. The Step 1.2 contracts hold as-is; no contract gap is expected from this
   step. If one surfaces, it is fixed and documented (as Step 1.3 did).
