# Pi Capability Platform — Second Capability (bash) + ProcessService Extraction: Design Report (Step 1.4)

**Status:** Implemented and validated
**Based on:** `docs/BASH_CAPABILITY_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

The second migrated capability (`bash`, after `read`) plus the platform's
**first service extraction beyond FileSystemService**: a real
`NodeProcessService` backing the bash pilot. The Step 1.3 walking skeleton
was untouched in structure; the bash capability traverses the same pipeline
with a real service dependency (`requires.services: ["process"]`), validating
that the migration pattern generalizes across a second service boundary.

| Component | Implementation | Minimal scope honored |
| --- | --- | --- |
| ProcessService | `NodeProcessService` (`packages/platform/src/kernel/process-service.ts`) | spawn (streamed, full), exec/shell (convenience, full), kill/getProcess, exit wait porting the pi#5303 semantics; `spawnPty` throws "not implemented" |
| ServiceProvider | `KernelServiceProvider` wires `NodeProcessService` (replaces the process stub) | `process` option for tests; all other services remain stubs |
| Manifest validation | `KernelCapabilityRegistry.register` validates with TypeBox `Value.Parse` against `CapabilityManifestSchema` | Full schema validation at registration; invalid manifests rejected with `VALIDATION_ERROR` |
| Pilot capability | `bash` (`packages/coding-agent/src/platform/bash-capability.ts`) | Adapter over the existing `createBashToolDefinition`; `BashOperations` backed by the injected `ProcessService` + `FileSystemService` |
| Consumption | `getPlatformBashToolDefinition(cwd, options)` in `platform-runtime.ts`; `_buildRuntime` sources bash from the registry with a legacy fallback | Same failure-safe shape as read; `executeBash` / `ctx.exec` untouched |

## 2. Validation Results

- `packages/platform/test/process-service.test.ts` — **18/18 pass** (spawn
  streaming, stdin pipes, exit codes, spawn-error rejection, abort/timeout
  kill, detached, descendant-held-stdio non-hang, exec collection, shell,
  kill/getProcess, not-implemented spawnPty).
- `packages/platform/test/kernel.test.ts` — **16/16 pass** (11 original + 5
  new manifest-schema-validation tests: valid accepted, invalid id, unknown
  required service, missing metadata, invalid permission level).
- `packages/coding-agent/test/bash-capability.test.ts` — **13/13 pass** (full
  lifecycle discovered/registered/resolved/initialized/ready/shutdown, real
  command execution through registry exports, cwd discipline, error results,
  missing-cwd error, commandPrefix/shellPath from metadata, timeout, abort,
  read+bash co-boot, consumption adapter, fallback when unbooted, error
  propagation, prefix passthrough).
- Existing behaviour unchanged: `test/tools.test.ts` (74/74),
  `test/platform-runtime.test.ts` (6/6), `test/suite/agent-session-bash-persistence.test.ts`
  (11/11), `test/suite/agent-session-prompt.test.ts` (13/13),
  `test/agent-session-concurrent.test.ts`, `test/session-id-readonly.test.ts`,
  `test/agent-session-dynamic-tools.test.ts`, `test/bash-close-hang-windows.test.ts`
  (skipped on non-Windows) all pass.
- Repo-wide `npm run check` green: biome (984 files), pinned-deps,
  ts-imports, shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke.
- `packages/platform` dist rebuilt (`tsgo -p tsconfig.build.json`) so the
  running binary resolves the new kernel (dist is gitignored).

## 3. Architectural Decisions

1. **The bash adapter uses `ProcessService.spawn`, not `exec`/`shell`.**
   `BashOperations.exec` streams output via `onData(Buffer)`; the contract's
   `exec`/`shell` return collected strings. The adapter pumps the
   `ProcessHandle` Web Streams into `onData`. `exec`/`shell` are implemented
   on the same spawn for the next extractions (Workspaces runs git via exec)
   and are covered by tests, but the pilot itself only exercises `spawn`.

2. **Process-tree kill semantics live in the kernel.** A shell's descendants
   are its command; killing only the shell orphans running commands. The
   kernel's `spawn` (signal abort) and `ProcessHandle.kill`/`ProcessService.kill`
   kill the process tree (POSIX process-group SIGKILL, Windows
   `taskkill /F /T`), matching the legacy `killProcessTree` behavior. The
   adapter therefore carries no tree-kill code.

3. **Exit wait ports the pi#5303 fix.** `ProcessHandle.exited` resolves on
   close, or after exit once the stdio pipes end, or after a 100ms idle grace
   re-armed on output — so detached descendants holding pipes can neither
   hang the caller nor truncate tail output. Verified by a test that spawns a
   detached grandchild with inherited stdio.

4. **Adapter state stays host-side.** Shell resolution (`getShellConfig`),
   cwd existence check (via the injected `FileSystemService`), timeout
   conversion (`resolveTimeoutMs`, exported additively), detached-pid tracking
   (`trackDetachedChildPid`, so mode shutdown still reaps children), and the
   bash-specific error strings all live in the coding-agent adapter. The
   kernel knows nothing about bash.

5. **Manifest validation at registration.** `Value.Parse(CapabilityManifestSchema, manifest)`
   replaces the id/version presence check; the TypeBox error details are
   wrapped in a `VALIDATION_ERROR` PlatformError. Both `read` and `bash`
   manifests and the kernel test fixtures pass. This retires the first
   walking-skeleton debt item from the Step 1.3 report.

6. **The bash renderers stay in bash.ts.** Unlike read's renderers (extracted
   as module functions in Step 1.3), bash's `renderCall`/`renderResult` are
   object methods on the definition; the consumption adapter takes them from a
   template `createBashToolDefinition("")` instead of touching bash.ts.

7. **Session env and live updates ride through execution metadata.** The
   consumption adapter forwards the real `ExtensionContext` (`metadata.extensionContext`)
   and the `onUpdate` callback (`metadata.onUpdate`) so the re-entered bash
   definition keeps setting `PI_SESSION_ID`/`PI_PROVIDER`/`PI_MODEL` and keeps
   streaming partial output exactly like the legacy definition. The read
   adapter already carried a function-bearing object (the model) through
   metadata, so this follows precedent.

## 4. Compromises

1. **`ProcessHandle.exited` resolves `-1` for signal-killed processes.** The
   Step 1.2 contract types it `Promise<number>`; a killed process has no exit
   code. `-1` is documented and consistent with `ExecResult.exitCode`.
2. **`NodeProcessService` spawns with `node:child_process` directly** (no
   cross-spawn). The bash shell on Windows is a real executable resolved by
   `getShellConfig`; `.bat`/`.cmd` resolution is out of scope for the pilot.
3. **`ExecOptions.maxBuffer` is ignored** in the skeleton; `exec` collects
   output unboundedly (documented in the design's assumptions).
4. **Web-Stream pump tolerates stream destruction by exit handling.** After
   `exited` resolves, the kernel destroys the underlying Node streams; the
   pump's read rejects and is swallowed. Verified correct for output fidelity
   by the streaming tests.
5. **Windows kill via `taskkill` is fire-and-forget** (legacy behavior),
   so `exited` resolution races the OS kill on Windows. POSIX kills are
   synchronous process-group signals.

## 5. Technical Debt (Intentional)

| Debt | Why accepted | Retirement |
| --- | --- | --- |
| `ProcessService.spawnPty` still a stub | Pilot needs spawn/exec/shell only | PTY feature phase |
| `exec`/`shell` unbounded output (maxBuffer ignored) | Not needed by the bash pilot | Alongside Workspaces extraction |
| Per-execution definition construction in the bash capability | Kept deliberately (walking skeleton; read precedent) | Third capability if it hurts |
| `metadata.extensionContext` / `metadata.onUpdate` transport | No `onUpdate` slot in `ToolExecutionContext`; pragmatic bridge | When `ToolExecutionContext` grows a proper callback/session slot |
| One kernel per process, boot-time workspace root | Unchanged from Step 1.3 | Host-contracts phase |
| `packages/platform/dist` must be rebuilt for the running binary | dist is gitignored; release builds it | Release pipeline (`npm run build`) |
| Remaining service stubs (settings/session/network/auth/cache/permissions/logging/configuration/telemetry) | Pilot needs fs + process only | Replace per service during extraction |

## 6. Deferred Functionality (Explicit Non-Goals, Confirmed Unimplemented)

Permission **enforcement** (`permissions: { process: "spawn" }` is declaration
only; `PermissionService` remains a stub), hot reload/restart, event-bus
replay / background-dispatcher roadmap, model providers, per-session runtimes,
host contracts, and all other tool migrations (write/grep/find/ls/edit stay
legacy). No changes to the Step 1.2 event model; no contract gaps surfaced
this step.

## 7. Assumptions

As listed in the design document (§9): direct node:child_process spawn;
`SpawnOptions.env` accepts `NodeJS.ProcessEnv`-shaped objects via a narrow
cast; `exec` collects unbounded; per-instance process tracking; one kernel
per process; the Step 1.2 contracts hold as-is (they did).

## 8. Recommended Next Step

The kernel's component boundaries held under two real capabilities with two
real services. The cheapest next validations, in order:

1. **Extract a third capability with a *peer-capability dependency* and no
   new service** (e.g. `grep`/`find`/`ls` on `fs`) — this exercises the
   `requires.capabilities` edge, which no migrated capability uses yet.
2. Then begin **service extraction behind existing implementations**
   (`SettingsService` from `SettingsManager`, `SessionService` from
   `SessionManager`) so capabilities stop using stubs, per the Step 1.3
   recommendation.
3. Only if a third capability hurts should the per-execution adapter pattern
   be refactored into a definition-factory form.
