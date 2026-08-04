# Pi Capability Platform — write/edit Migration + the fs Write Surface: Design Report (Step 1.9)

**Status:** Implemented and validated
**Based on:** `docs/WRITE_EDIT_MIGRATION_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

The **builtin tool surface is complete on the platform**: `write` and `edit`
migrated onto the capability platform, the `FileSystemService`'s write
surface (`write`/`append`/`delete`/`mkdir`/`copy`/`move`) is real instead of
`NOT_IMPLEMENTED`, and the platform ships its **first non-read permission**
(`permissions: { fs: "write" }`). Every builtin tool — read, bash, grep, find,
ls, write, edit — now has a platform capability backed by real services;
nothing is left on the legacy path except the Step 1.10 gate question
(platform as the default execution path instead of a silent fallback).

The step also retires the Step 1.8 report's named sub-item: the five
(now seven) adapters that each built and ran a per-execution definition with
the identical try/catch result mapping now share `executePlatformTool` in
`packages/coding-agent/src/platform/tool-execution.ts`.

| Component | Implementation | Minimal scope honored |
| --- | --- | --- |
| fs write surface | `NodeFileSystemService.write`/`append`/`delete`/`mkdir`/`copy`/`move` — thin node:fs wrappers (`writeFile`/`appendFile`/`rm`/`mkdir`/`cp`/`rename`), `copy` no-clobber by default (`force` + `errorOnExist`), `watch` stays `NOT_IMPLEMENTED` | Contract untouched; `WriteOptions`/`DeleteOptions`/`MkdirOptions`/`CopyOptions` used as defined |
| write capability | `tool.write` (`packages/coding-agent/src/platform/write-capability.ts`) — `WriteOperations.mkdir` → `fs.mkdir(dir, { recursive: true })`, `writeFile` → `fs.write(path, content)` | First `permissions: { fs: "write" }`; `writeSchema` exported additively from the tool |
| edit capability | `tool.edit` (`packages/coding-agent/src/platform/edit-capability.ts`) — `access` (exists → `ENOENT`, empty-append writability probe → `EACCES`), `readFile` → `Buffer.from(fs.readBytes)`, `writeFile` → `fs.write` | No `tool.read` peer edge (edit needs a Buffer, not read's string export); `editSchema` exported additively |
| Shared execute helper | `executePlatformTool` (`src/platform/tool-execution.ts`) — one try/catch result mapping used by all seven adapters; read's model-shaped `extensionContext` and bash's `onUpdate` are options, not forks | Pure deduplication; behavior byte-identical (existing tests prove it) |
| Consumption | `getPlatformWriteToolDefinition`/`getPlatformEditToolDefinition` in `platform-runtime.ts`; `_buildRuntime` sources write/edit from the registry with legacy fallback | Edit carries the template's `prepareArguments` + `renderShell: "self"` through the registry-built definition |

## 2. Validation Results

- `packages/platform/test/fs-service.test.ts` — **26/26 pass** (write surface
  rewritten: write+overwrite, binary content, `createDirs`, append to
  existing/missing files, delete file + recursive dir + force, mkdir +
  recursive, copy with no-clobber/overwrite + directory trees, move; watch
  stays `NOT_IMPLEMENTED`).
- `packages/platform/test/kernel.test.ts` — **20/20 pass** (+1): a fixture
  capability calls `ctx.fs.mkdir`/`ctx.fs.write`/`ctx.fs.append` in init and
  exports the read-back content + listing through the registry — the injected
  fs service answers write-side queries end to end.
- `packages/coding-agent/test/write-edit-capability.test.ts` — **13/13 pass**
  (new): write/edit lifecycle (discovered/registered/ready,
  `requires.services: ["fs"]`, `permissions.fs: "write"`, reverse-order
  shutdown), write with parent-dir creation, write overwrite, write error
  through ToolResult, edit single + multi-edit (diff + patch details),
  ENOENT for a missing target, EACCES for a read-only file, UTF-8 BOM
  preservation through the platform read/write path, runtime co-boot
  (write+edit `Ready` alongside the existing set), and the consumption
  adapters (undefined when unbooted, working `ToolDefinition`s with
  `renderCall`/`renderResult`, edit's `prepareArguments` + `renderShell`).
- `packages/coding-agent/test/platform-runtime.test.ts` — **12/12 pass**
  (+2): write and edit consumption adapters build working definitions
  through the booted runtime.
- Existing behaviour unchanged: `test/tools.test.ts` (74/74 — the legacy
  write/edit paths), `test/grep-capability.test.ts` (15/15),
  `test/find-ls-capability.test.ts` (12/12), `test/bash-capability.test.ts`
  (13/13), `test/session-service.test.ts` (10/10),
  `test/settings-service.test.ts` (8/8), `test/session-id-readonly.test.ts`
  (7/7), `test/agent-session-concurrent.test.ts` (7/7),
  `test/agent-session-dynamic-tools.test.ts` (4/4),
  `test/suite/agent-session-bash-persistence.test.ts` (11/11),
  `test/suite/agent-session-prompt.test.ts` (13/13),
  `test/edit-tool-legacy-input.test.ts` (8/8), and the remaining
  `test/suite` files (50 files / 174 tests incl. regressions).
- Final combined run: **199/199 coding-agent + 64/64 platform**.
- Repo-wide `npm run check` exit 0: biome (998 files), pinned-deps,
  ts-imports, shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke.
- No lockfile changes this step (no new dependencies — the fs write surface
  is plain node:fs).
- `packages/platform` dist rebuilt (`tsgo -p tsconfig.build.json`) so the
  running binary resolves the new fs surface (dist is gitignored).

## 3. Architectural Decisions

1. **The fs write surface is plain node:fs passthrough — no new dependency.**
   `write`/`append`/`delete`/`mkdir`/`copy`/`move` map 1:1 onto
   `fs/promises` calls with the contract options passed through. Unlike
   `glob` (which needed minimatch), the write side has no matching logic.
2. **`copy` defaults to no-clobber and is loud about it.** The contract's
   `overwrite` name implies opt-in; `force: false` alone silently ignores an
   existing dest in node's `fs.cp`, so `errorOnExist: true` is set unless
   overwriting. A dest collision throws instead of silently skipping.
3. **The edit adapter reproduces the legacy `fs.access(R_OK | W_OK)` error
   surface from service methods, not a contract change.** `FileSystemService`
   has no `access` method and the Step 1.2 contracts are frozen: `fs.exists`
   yields the `ENOENT` code and an **empty-append writability probe**
   (`fs.append(path, "")`) yields `EACCES` for read-only files — verified
   against node's behavior (`fs.open` with the append flag checks write
   permission at open, before any byte is written). The tool's documented
   error messages (`Could not edit file: X. Error code: ENOENT/EACCES.`)
   are produced unchanged on both paths.
4. **edit does not declare a `tool.read` peer edge.** The grep→read edge
   exists because grep needs the read capability's string-typed
   `readTextFile` export. Edit's `readFile` operation needs a `Buffer` (BOM
   and line-ending preservation in edit-diff.ts operate on bytes); the read
   capability's export is the wrong shape, so `ctx.fs.readBytes` is the right
   backing. The manifest declares what the adapter actually uses.
5. **`watch` stays `NOT_IMPLEMENTED`.** Watching is event-system territory
   (`docs/EVENT_ARCHITECTURE.md` is a later roadmap feature), not an fs
   write-surface concern; the write side of the contract is otherwise
   complete.
6. **The shared execute helper is a required deduction, not an option.**
   Seven copies of the same try/catch block is the Step 1.8 report's named
   debt; `executePlatformTool` unifies them with the two special cases (read's
   model-shaped `extensionContext`, bash's metadata-carried `onUpdate`) as
   optional parameters. The read/bash paths were refactored onto it too —
   the cleanup is all-or-nothing, so the debt cannot quietly re-accumulate.
7. **The edit registry definition carries `prepareArguments` and
   `renderShell: "self"` from the template.** The agent loop runs
   `prepareArguments` before schema validation (legacy `oldText`/`newText`
   compat) and the TUI consults `renderShell` for the shell frame; both are
   object members of the tool definition, so the platform-built definition
   copies them from the template like it does the renderers.

## 4. Compromises

1. **The edit adapter's `access` probes writability but not readability.** A
   mode-0222 file passes the probe and fails later at `readFile` with a raw
   `EACCES` instead of the nice "Could not edit file" message the legacy
   path produced. Readability is implied by writability for essentially every
   real edit target; documenting beats adding a full-file read to the access
   check.
2. **`move` is plain `fs.rename`** — no cross-device (EXDEV) copy fallback.
   Fine for workspace-sized moves; the Workspaces step can grow it.
3. **The platform write path has no transactionality beyond the tools'.**
   The write/edit tools' `withFileMutationQueue` serialization and the
   edit-tool's apply-then-verify semantics are unchanged and still live in
   the tools — the platform provides the fs operations, not new guarantees.
4. **The write/edit adapters ride sessionId through execution metadata**
   like the other adapters; the session transport retirement is still pending
   the `ToolExecutionContext` session slot (Step 1.7 deferred item,
   unchanged).

## 5. Technical Debt (Intentional)

| Debt | Why accepted | Retirement |
| --- | --- | --- |
| `permissions.fs: "write"` is declaration only — `PermissionService` remains a stub | Enforcement is a later step; this step ships the first non-read *declaration* | With the PermissionService (Approval Framework / policies) |
| `fs.move` has no EXDEV fallback | Workspace-sized moves are same-device | Workspaces step |
| `NodeFileSystemService.watch` stub | Event system is a later roadmap feature | Event System step |
| Remaining service stubs (network/auth/cache/events/permissions/logging/configuration/telemetry) | Tool surface needs fs/process/settings/session only | Replace per service during extraction |
| Per-execution definition construction remains (now via the shared helper) | Walking skeleton; each adapter builds operations + definition per call | Re-evaluate at the Step 1.10 gate |
| `packages/platform/dist` must be rebuilt for the running binary | dist is gitignored; release builds it | Release pipeline (`npm run build`); tests run against src via vitest aliases |

## 6. Deferred Functionality (Explicit Non-Goals, Confirmed Unimplemented)

Permission **enforcement** (`permissions.fs: "write"` is declaration only),
hot reload/restart, event-bus replay / background-dispatcher roadmap, model
providers, per-session runtimes, host contracts, `.gitignore`-aware glob, fd
parity, write/edit tool rewrites (they are adapters), and the Step 1.10 gate
(platform as the default execution path instead of a silent fallback). No
changes to the Step 1.2 event model or contracts; no contract gaps surfaced
this step (`WriteOptions`/`DeleteOptions`/`MkdirOptions`/`CopyOptions` were
used as defined — the edit adapter composes declared methods instead of
adding an `access` method).

## 7. Assumptions

As listed in the design document (§8): the empty-append probe reproduces the
legacy `W_OK` semantics (verified against node); `copy` no-clobber defaults
are a walking-skeleton choice with nothing in-tree consuming them yet;
readability is not probed by `access`; the shared helper is pure
deduplication with byte-identical behavior; write/edit manifests declare
what they do (fs write, no peer capability); the Step 1.2 contracts hold
as-is (they did).

## 8. Recommended Next Step

The **builtin tool surface is complete on the platform**: read, bash, grep,
find, ls, write, and edit all have platform capabilities backed by real
services (fs/process/settings/session), the fs service covers both sides of
the tool surface, and the platform ships its first write permission. The
remaining work on the Capability Platform path is the gate itself:

1. **Step 1.10 — Capability Platform complete.** The gate: the platform
   becomes the **default execution path** for all builtin tools, not a
   silent fallback. Today `_buildRuntime` still starts from the legacy
   definitions and overlays platform ones when the kernel is booted — the
   gate inverts that (platform-first construction, legacy as the
   developer/edge fallback) and decides what happens when the kernel fails
   to boot mid-session. The permission-declaration surface now exists for
   both read and write, so the gate can also tighten the manifest→tool
   description coupling.
2. **Cheap sub-items available before the gate**: the platform-runtime
   `buildXToolDefinition` functions (seven near-identical adapters) are the
   same duplication the capabilities just shed; and the manifest
   descriptions could be sourced from the templates instead of hand-copied
   strings (they have drifted slightly from the tools' descriptions over
   the steps — a fixture asserting manifest↔tool description equality would
   pin them).

The step cadence stays one capability-or-service per step; the event system,
planning, and Workspaces (`docs/WORKSPACE_ARCHITECTURE.md`) — whose full
substrate (fs with glob/list + write surface, process, settings, session) is
now in place — are the designed downstream consumers.
