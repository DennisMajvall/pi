# Pi Capability Platform — find/ls + the grep Search Seam: Design Report (Step 1.8)

**Status:** Implemented and validated
**Based on:** `docs/FIND_LS_SEARCH_SEAM_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

The **read-only tool set is complete on the platform**: `find` and `ls`
migrated onto the capability platform (after read, bash, grep), the
`FileSystemService` gained the `glob`/`list` operations it threw for, and the
Step 1.5 compromise — the ripgrep search staying host-side — is retired via a
real `GrepOperations.search` seam backed by `ProcessService`. Every service
the read-only pilots touch (fs/process/settings/session) was already real;
this step closes the last read-side fs gap and the last host-side process.

| Component | Implementation | Minimal scope honored |
| --- | --- | --- |
| `fs.glob` | `NodeFileSystemService.glob` — deterministic minimatch walk (literal-prefix walk root, `**`-aware descent, dotfile rule, ignore-pruning, nodir/absolute options) | First runtime dep beyond typebox: `minimatch` pinned `10.2.5` (same pin as the coding-agent) |
| `fs.list` | `NodeFileSystemService.list` — `readdir` + per-entry `stat`, `includeHidden`/`recursive`/`filter`, deterministic path order | Write surface stays `NOT_IMPLEMENTED` |
| find capability | `tool.find` (`packages/coding-agent/src/platform/find-capability.ts`) — `FindOperations` backed by `ctx.fs`; `findSchema` exported from the tool | fd never consulted; the tool's custom-glob path runs the search through `fs.glob` |
| ls capability | `tool.ls` (`packages/coding-agent/src/platform/ls-capability.ts`) — `LsOperations` backed by `ctx.fs`; `lsSchema` exported | `fs.list` with `includeHidden` (the tool shows dotfiles) |
| grep search seam | `GrepOperations.search(rgPath, args, options)` added to `tools/grep.ts`; default ops = verbatim legacy spawn; the grep capability supplies a `ProcessService`-backed implementation pumping Web Streams into JSON-line/stderr callbacks | rg binary resolution (`ensureTool`) stays in the tool; only the process spawn moved behind the seam |
| Manifest honesty | `grepManifest.requires.services` → `["fs", "process"]`, `permissions` → `{ fs: "read", process: "spawn" }` | The manifest now declares what grep does |
| Consumption | `getPlatformFindToolDefinition` / `getPlatformLsToolDefinition` in `platform-runtime.ts`; `_buildRuntime` sources find/ls from the registry with a legacy fallback | Same failure-safe shape as read/bash/grep |

## 2. Validation Results

- `packages/platform/test/fs-service.test.ts` — **18/18 pass** (new):
  - glob: basename patterns at walk-root level, `**` recursion with the
    dotfile rule (`.git/g.ts` and `.hidden.ts` excluded from `**/*.ts`),
    ignore pruning (`node_modules` not descended into), path-containing
    patterns (`src/**/*.spec.ts`, `src/*.ts`), brace alternation, absolute
    results, absolute patterns walked from their own literal prefix,
    `nodir`, literal (magic-free) patterns, hidden entries via explicit dot
    segments, missing walk root → empty;
  - list: direct entries sorted with hidden excluded by default,
    `includeHidden`, `recursive` (basename `name`, absolute `path`),
    `filter`, isFile/isDirectory/size/name per entry, missing-directory and
    file-path rejection;
  - write surface: `write`/`append`/`delete`/`mkdir`/`copy`/`move`/`watch`
    still throw `PlatformError` `NOT_IMPLEMENTED`.
- `packages/platform/test/kernel.test.ts` — **19/19 pass** (+1): a fixture
  capability calls `ctx.fs.glob("**/*.md")` and `ctx.fs.list(".",
  { includeHidden: true })` in init and exports the results through the
  registry — the injected fs service answers read-side queries end to end.
- `packages/coding-agent/test/find-ls-capability.test.ts` — **12/12 pass**
  (new): find/ls lifecycle (discovered/registered/ready, `requires.services:
  ["fs"]`, `permissions.fs: "read"`, reverse-order shutdown), find by
  recursive basename pattern with node_modules/.git/dotfile exclusion,
  cwd-relative `path: "src"`, no-match + missing-path results, search outside
  the workspace root via absolute patterns, ls with dotfiles + directory
  suffixes, subdirectory listing, missing-path + file-path errors, runtime
  co-boot (find+ls `Ready` alongside the existing set), and the consumption
  adapters (undefined when unbooted, working `ToolDefinition`s with
  `renderCall`/`renderResult`).
- `packages/coding-agent/test/grep-capability.test.ts` — **15/15 pass**
  (+3 search-seam tests, existing 12 unchanged): a `RecordingProcessService`
  spy proves the rg search goes through `ctx.process.spawn` (one spawn, the
  rg binary, `--json`/`--line-number` args, the search path), the match-limit
  kill through the seam reports "10 matches limit reached" deterministically,
  and an already-aborted signal rejects at entry.
- `packages/coding-agent/test/platform-runtime.test.ts` — **10/10 pass**
  (+2): find and ls consumption adapters build working definitions through
  the booted runtime.
- Existing behaviour unchanged: `test/tools.test.ts` (74/74 — the legacy
  find/ls/grep paths, including the grep refactor's default search),
  `test/session-service.test.ts` (10/10), `test/settings-service.test.ts`
  (8/8), `test/bash-capability.test.ts` (13/13), `test/session-id-readonly.test.ts`
  (7/7), `test/agent-session-concurrent.test.ts` (7/7),
  `test/agent-session-dynamic-tools.test.ts` (4/4),
  `test/suite/agent-session-bash-persistence.test.ts` (11/11),
  `test/suite/agent-session-prompt.test.ts` (13/13).
- Final combined run: **184/184 coding-agent + 55/55 platform**.
- Repo-wide `npm run check` green: biome (990 files), pinned-deps,
  ts-imports, shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke.
- Lockfiles: root `package-lock.json` gains the `minimatch` dep under the
  platform workspace entry; `packages/coding-agent/npm-shrinkwrap.json` and
  `packages/coding-agent/install-lock` regenerated (+1 line each: the
  platform entry's `minimatch` pin — already present in the shrinkwrap via
  the coding-agent's direct pin, so no new package entries).
- `packages/platform` dist rebuilt (`tsgo -p tsconfig.build.json`) so the
  running binary resolves the new fs service (dist is gitignored).

## 3. Architectural Decisions

1. **minimatch is the platform's first runtime dependency beyond typebox.**
   Glob matching is not hand-rolled in a walking skeleton. `minimatch` is
   already a pinned direct dep of the coding-agent (same exact pin `10.2.5`),
   so no new transitive surface. The lockfile + shrinkwrap + install-lock
   changes were regenerated by the existing scripts and reviewed like any dep
   change.
2. **`fs.glob` stays standard glob; fd-compat rules live in the find
   adapter.** The service speaks minimatch semantics (dotfile rule, `**`
   crossing segments, patterns relative to the workspace root, absolute
   patterns per the "cwd-agnostic for absolute paths" design note). The
   fd quirks the find tool relies on (`*.ts` matching basenames at any depth;
   `path`-relative evaluation) are the adapter's job: it prefixes
   `**/` to slash-free patterns and prefixes the search path, falling back to
   absolute patterns when the search path is outside the workspace root.
3. **The search seam is a required `GrepOperations` member, and the default
   implementation is the verbatim legacy spawn.** The interface's only
   in-tree implementations are the default ops and the capability adapter;
   an optional seam would silently fall back to host spawning — the exact
   thing the seam exists to remove. The default keeps `spawn(rgPath, args,
   { stdio: [...] })` with no cwd, `child.kill()`, and close-code/null
   semantics byte-for-byte; `tools.test.ts`'s grep suite proves it.
4. **The platform grep search is a Web-Stream pump over
   `ctx.process.spawn`, with the exit code resolved after the pumps drain.**
   `handle.exited` resolves `-1` for signal-killed processes (vs `null` close
   codes on the legacy path); the tool's existing `aborted` /
   `killedDueToLimit` / `code !== 0 && code !== 1` checks treat both
   identically. Draining stderr after exit removes the last-chunk race for
   error messages.
5. **The fs-service stub signatures now match the `FileSystemService`
   interface** (`write`/`append`/`delete`/`mkdir`/`copy`/`move`/`watch` take
   their contract parameters) while still throwing `NOT_IMPLEMENTED`. This is
   honest walking-skeleton shape and lets callers type against the service
   directly; the Step 1.2 contract itself is untouched.
6. **grep's manifest declares its process use** (`requires.services:
   ["fs", "process"]`, `permissions: { fs: "read", process: "spawn" }`),
   matching how bash declares `process: "spawn"`.

## 4. Compromises

1. **The platform find path is not fd.** It applies the explicit ignore list
   (`**/node_modules/**`, `**/.git/**`) and the standard dotfile rule;
   `.gitignore` awareness and `--hidden` search remain fd features on the
   legacy path. Behavior is documented (§2 of the design), not silently
   different; the find tool's "Respects .gitignore" description stays
   accurate for the default legacy path.
2. **Exit-code normalization is implicit.** `null` (legacy killed) and `-1`
   (platform killed) both pass the existing guards; no new normalization code
   was added.
3. **The platform glob is a plain minimatch walk**, pruned by the literal
   pattern prefix, `**`-presence, the ignore list, and the hidden-dir
   descent heuristic — not fd-fast. Fine for workspace-sized trees;
   performance belongs to the eventual Workspaces indexing step.
4. **The find/ls adapters ride sessionId through execution metadata** like
   grep does; the session transport retirement is still pending the
   `ToolExecutionContext` session slot (Step 1.7 deferred item, unchanged).

## 5. Technical Debt (Intentional)

| Debt | Why accepted | Retirement |
| --- | --- | --- |
| Platform find lacks `.gitignore`/`--hidden` (fd parity) | The fs service is a generic minimatch walk; fd semantics are not contract material | A gitignore-aware glob mode on `fs.glob`, or fd-backed search behind a `FindOperations` variant |
| `NodeFileSystemService` write surface (`write`/`append`/`delete`/`mkdir`/`copy`/`move`/`watch`) still stubs | Write side is Step 1.9's candidate | Alongside write/edit migration |
| grep/find/ls `sessionId` rides execution metadata | `ToolExecutionContext` has no session slot beyond the fixed one | When the execution contract grows a proper slot, or with per-session runtimes (Workspaces) |
| Per-execution definition construction in all five adapters | Kept deliberately (walking skeleton; read/bash precedent) | Re-evaluate now that there are five — a shared definition-factory is the natural Step 1.9/1.10 cleanup |
| Remaining service stubs (network/auth/cache/events/permissions/logging/configuration/telemetry) | Read-only pilots need fs/process/settings/session only | Replace per service during extraction |
| `packages/platform/dist` must be rebuilt for the running binary | dist is gitignored; release builds it | Release pipeline (`npm run build`); tests run against src via vitest aliases |

## 6. Deferred Functionality (Explicit Non-Goals, Confirmed Unimplemented)

Permission **enforcement** (`permissions.fs`/`permissions.process` are
declaration only; `PermissionService` remains a stub), hot reload/restart,
event-bus replay / background-dispatcher roadmap, model providers, per-session
runtimes, host contracts, write/edit migration, `.gitignore`-aware glob, fd
parity, and the Step 1.10 gate (platform as the default execution path
instead of a silent fallback). No changes to the Step 1.2 event model or
contracts; no contract gaps surfaced this step (`GlobOptions`/`ListOptions`
were used as defined — the search-path base is carried by the adapter, not a
new contract field).

## 7. Assumptions

As listed in the design document (§8): the platform find path uses standard
glob semantics with an explicit ignore list rather than fd's gitignore
handling; `minimatch` is a new (already-pinned-elsewhere) platform dep; the
seam's `number | null` exit code covers both backends; `search` is a required
member with only in-tree implementations; the fs glob is not fd-fast; `list`
reports basenames even when recursive; one kernel per process; the Step 1.2
contracts hold as-is (they did).

## 8. Recommended Next Step

The read-only tool set is complete: read, bash, grep, find, and ls all have
platform capabilities backed by real services (fs/process/settings/session),
and the last host-side process (rg) moved behind `ProcessService`. The
remaining builtin tools are the write side, and the roadmap already names the
step:

1. **Step 1.9 — the write side (write/edit migration).** The fs write surface
   (`write`/`append`/`delete`/`mkdir`/`copy`/`move`) is still
   `NOT_IMPLEMENTED`; the `write`/`edit` tools (plus the
   `file-mutation-queue`) are the last builtin tools on the legacy path.
   Migrating them exercises the platform's first non-read permissions
   (`permissions: { fs: "write" }`) and completes the tool surface — the
   natural precursor to the Step 1.10 gate. The shared definition-factory
   cleanup (five adapters now) is a cheap sub-item of this step.
2. **Step 1.10 — Capability Platform complete** (the gate: the platform is
   the default execution path for all builtin tools, not a silent fallback).
   After write/edit, the platform has no builtin left on the legacy path and
   the fallback becomes a developer/edge affordance rather than the default.

The step cadence stays one capability-or-service per step; the adapter
pattern remains (the definition-factory refactor is now justified by the
fifth capability); the event system, planning, and Workspaces
(`docs/WORKSPACE_ARCHITECTURE.md`) — whose full substrate (fs with glob/list,
process, settings, session) is now in place — are the designed downstream
consumers.
