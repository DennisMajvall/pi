# Pi Capability Platform — find/ls + the grep Search Seam (Step 1.8)

**Status:** Design (pre-implementation)
**Based on:** `docs/SESSION_SERVICE_REPORT.md` §8 (recommended next step), `docs/GREP_CAPABILITY_REPORT.md` §5 (search-seam debt), `docs/RUNTIME_KERNEL_DESIGN.md` §"cwd-agnostic for absolute paths"
**Date:** 2026-02-08

---

## 1. Objective

Complete the **read-only tool set** on the capability platform. Three pieces:

1. **Extend `NodeFileSystemService`** with the `glob` and `list` operations it
   currently throws "not implemented" for — the last fs-service gap the
   read-only tools touch.
2. **Migrate `find` and `ls`** onto the platform as `tool.find` / `tool.ls`
   capabilities, using the established read/bash/grep adapter pattern
   (`FindOperations` / `LsOperations` backed by the injected `FileSystemService`).
3. **Add the `GrepOperations` search seam** that routes the ripgrep search
   process behind `ProcessService` — retiring the Step 1.5 compromise where
   the rg spawn stayed host-side (`node:child_process`) on both paths.

After this step every builtin read-only tool (read, bash, grep, find, ls) is
migratable to the platform, the platform's fs surface covers the read side of
the tool set, and the only remaining read-only gaps are the Step 1.10 gate
question (making the platform the default execution path) and the write side
(write/edit, Step 1.9 candidate).

## 2. What Stays the Same (from Steps 1.3–1.7)

| Aspect | Status |
|---|---|
| Kernel component boundaries (registry/resolver/loader/lifecycle/service-provider/event-bus) | Unchanged |
| `read`, `bash`, `grep` capabilities and their consumption wiring | Unchanged except grep's adapter gains a process-backed search operation (§5.3) |
| Step 1.2 contracts (capability/runtime/service/event/error/identifier/schema) | **Frozen** — no contract change this step; `GlobOptions`/`ListOptions` used as defined |
| Event model | Untouched |
| Failure-safe consumption pattern (`ensurePlatformRuntime` + fallback) | Extended to find/ls, same shape |
| Adapter-over-rewrite pattern (per-execution definition construction) | Kept; find/ls/grep are adapters, not rewrites |
| `find`/`ls`/`grep` legacy tool implementations | Untouched except: `findSchema`/`lsSchema` become additive exports (§5.1/§5.2) and `GrepOperations` gains a `search` member (§5.3) |
| Manifest validation at registration (`Value.Parse` against `CapabilityManifestSchema`) | New manifests pass the same gate |
| The write side (write/edit/file-mutation-queue) | Legacy, untouched (Step 1.9 candidate) |
| `NodeFileSystemService` write/delete/mkdir/copy/move/watch | Still "not implemented" |

## 3. Why These Three Pieces Belong Together

The Step 1.5 report (§5) recorded three related debts with one retirement
path: `fs.glob`/`fs.list` stubs (blocking find/ls) and the grep search seam
(blocking rg behind `ProcessService`). The Step 1.7 report's §8 picked them
up as a single step because they share one validation goal: **every read-only
tool is migratable with real services and no process or fs gap**.

| Piece | Seam it exercises | Service gap it closes |
| --- | --- | --- |
| `fs.glob` + `fs.list` | First implementation of the two read-side fs operations | glob/list stubs retired |
| `find` capability | `FindOperations.glob` (custom-glob path, no fd) | find migrates without fd |
| `ls` capability | `LsOperations.readdir`/`stat`/`exists` | ls migrates |
| grep search seam | `GrepOperations.search` | rg spawn moves behind `ProcessService` |

## 4. FileSystemService: glob + list (platform kernel)

`packages/platform/src/kernel/fs-service.ts` implements the two operations
the contract already declares. The contract itself is untouched.

### 4.1 `list(path, options?: ListOptions): Promise<FileStat[]>`

Semantics:

- Resolves `path` against the workspace root (existing `resolve()`), reads
  directory entries with `fs.readdir({ withFileTypes: true })`.
- `includeHidden` (default `false`): entries whose name starts with `.` are
  skipped unless included.
- `recursive` (default `false`): descend into subdirectories; entries below
  the root are reported with their **basename** in `name` and their absolute
  path in `path` (consumers that need the relative path derive it from
  `path` — consistent with `stat()`).
- `filter`: applied per-entry before the result is added.
- Result order: deterministic, case-insensitive alphabetical by name.
- Each `FileStat` is built with `fs.stat` (size, mtimes, isFile/isDirectory).
- Errors propagate (ENOENT for a missing path, ENOTDIR for a file path) —
  the caller decides how to surface them.

### 4.2 `glob(pattern: string, options?: GlobOptions): Promise<string[]>`

Pattern engine: **`minimatch`** (pinned `10.2.5`, already a direct pinned
dependency of the coding-agent; the platform adds it as its first runtime
dependency beyond typebox). Hand-rolling a glob matcher is error-prone and
out of scope for a walking skeleton; minimatch is the same engine the
coding-agent already uses for package-manager/model-resolver matching.

Semantics:

- Patterns are **workspace-relative** (posix separators) by default, and the
  service is **cwd-agnostic for absolute patterns** (per
  `docs/RUNTIME_KERNEL_DESIGN.md` §"cwd-agnostic for absolute paths"):
  an absolute pattern (e.g. `/tmp/ws/src/**/*.ts`) is walked from its own
  literal prefix. This matches how `read`/`stat` already accept absolute
  paths; sandbox enforcement is the deferred PermissionService's job.
- Standard glob syntax: `*`, `?`, `[...]`, `{a,b}`, `**` (crosses segment
  boundaries), literal segments, backslash escapes.
- **Dotfile rule** (minimatch default): an entry whose name starts with `.`
  is only matched by a pattern segment that itself starts with `.` (e.g.
  `.*`, `.git/**`). This is the gitignore-style rule; the service does **not**
  search hidden entries for `*` patterns.
- `options.ignore` (e.g. `["**/node_modules/**", "**/.git/**"]`): entries
  matching an ignore pattern are excluded from results, and directories
  matching are **not descended into** (ignore patterns are tested with a
  trailing `/**` stripped as well, so `**/node_modules/**` also excludes and
  prunes the directory `node_modules` itself).
- `options.nodir` (default `false`): exclude directory entries from results
  (files only).
- `options.absolute` (default `false`): return absolute paths; otherwise
  workspace-relative posix paths. Absolute patterns always return absolute
  paths.
- Walk root: the **literal (magic-free) prefix** of the pattern — the search
  never walks parts of the tree the pattern cannot reach. Patterns without
  `**` only test the direct children of the walk root (e.g. `src/*.ts` never
  descends into `src/sub/`).
- Deterministic order: sorted by path.

### 4.3 Dependency

`packages/platform/package.json` gains `"minimatch": "10.2.5"` (exact pin,
matching the coding-agent's pin). Lockfile churn: the root `package-lock.json`,
the coding-agent `npm-shrinkwrap.json`, and `packages/coding-agent/install-lock`
are regenerated with the existing scripts (`npm install --package-lock-only
--ignore-scripts`, `node scripts/generate-coding-agent-shrinkwrap.mjs`, and
the install-lock generator) and reviewed like any dep change.

## 5. Capabilities (coding-agent)

### 5.1 find: `tool.find`

`packages/coding-agent/src/platform/find-capability.ts` — adapter over the
existing `createFindToolDefinition`, mirroring read/bash/grep:

- Manifest: `requires.services: ["fs"]`, `permissions: { fs: "read" }`,
  `provides.tool.parameters: findSchema`. `findSchema` becomes an additive
  export of `tools/find.ts` (mirroring how `grepSchema` was exported in
  Step 1.5).
- `FindOperations` backed by the injected `FileSystemService`:
  - `exists: (p) => ctx.fs.exists(p)` (boolean, never throws — matches the
    tool's check),
  - `glob: (pattern, searchPath, { ignore })` → `ctx.fs.glob(...)`.
- **fd-compat rules** owned by the adapter (the fs service itself stays
  standard-glob):
  - a pattern **without** `/` is prefixed with `**/` — fd's documented
    basename matching (`*.ts` finds `.ts` files at any depth), and the
    tool's own docstring examples (`*.ts`, `**/*.json`) behave identically;
  - a pattern **with** `/` is used as-is;
  - the pattern is evaluated relative to `searchPath`: when `searchPath` is
    inside the workspace root it is prefixed with the relative path
    (`src` + `**/*.ts` → `src/**/*.ts`); when outside, an absolute pattern
    `{searchPath}/{pattern}` is passed (the fs service walks absolute
    patterns);
  - `absolute: true` (the tool relativizes against `searchPath`),
    `nodir: false` (fd returns directories too), `ignore` passed through.
  - `limit` is accepted but not enforced — the tool itself truncates to the
    effective limit with a notice (the custom-glob path never enforced it).

### 5.2 ls: `tool.ls`

`packages/coding-agent/src/platform/ls-capability.ts` — same adapter shape:

- Manifest: `requires.services: ["fs"]`, `permissions: { fs: "read" }`,
  `provides.tool.parameters: lsSchema` (additive export of `tools/ls.ts`).
- `LsOperations` backed by `ctx.fs`:
  - `exists: (p) => ctx.fs.exists(p)`,
  - `stat: async (p) => ({ isDirectory: () => (await ctx.fs.stat(p)).isDirectory })`
    — the contract's `FileStat.isDirectory` is a boolean; the tool's
    `LsOperations.stat` expects a predicate-typed shape, so the adapter
    bridges it,
  - `readdir: async (p) => (await ctx.fs.list(p, { includeHidden: true })).map((s) => s.name)`
    — the ls tool includes dotfiles (its description says so), so the adapter
    requests them explicitly.

### 5.3 grep: the search seam

`tools/grep.ts` — `GrepOperations` gains one member:

```ts
export interface GrepSearchOptions {
	cwd: string;
	signal?: AbortSignal;
	onStdoutLine: (line: string) => void;   // complete JSON lines from rg stdout
	onStderr: (chunk: string) => void;      // stderr text chunks
}

export interface GrepSearchProcess {
	exited: Promise<number | null>;         // exit code; null when killed
	kill(): void;                           // kill the rg process tree
}

export interface GrepOperations {
	isDirectory: ...;
	readFile: ...;
	search: (rgPath: string, args: string[], options: GrepSearchOptions) => GrepSearchProcess;
}
```

- The **default** implementation is the current behavior, moved verbatim:
  `spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] })` (no cwd,
  matching today), readline over stdout, stderr accumulation, `kill()`
  guarded by `child.killed`, `exited` resolving with the close code (null
  when killed, rejecting on spawn error — the tool maps that to
  "Failed to run ripgrep: ...").
- The tool's `execute` uses the seam: `ensureTool("rg")` stays, the JSON
  streaming/match-collection/limit-kill/formatting logic moves behind
  `ops.search(...)`, and the abort handling kills the search process via
  the returned handle. Legacy behavior is preserved exactly (the default ops
  run the identical child_process spawn).
- `grep-capability.ts` supplies a **ProcessService-backed** implementation:
  `ctx.process.spawn(rgPath, args, { cwd, signal, stdio: [...] })`, pumping
  the `ProcessHandle` Web Streams into `onStdoutLine` (newline-delimited
  decode) / `onStderr`, `exited` from `handle.exited` (awaited after the
  pumps drain so stderr races cannot lose the last chunk), `kill()` →
  `handle.kill()` (process-tree kill — the kernel's SIGKILL semantics, which
  differs from the legacy SIGTERM only in how hard it kills).
- `grepManifest.requires.services` becomes `["fs", "process"]` and
  `permissions` becomes `{ fs: "read", process: "spawn" }` — the manifest now
  honestly declares that grep spawns a search process.

## 6. Consumption Wiring

`platform-runtime.ts`:

- `builtins: [readCapability, bashCapability, grepCapability, findCapability, lsCapability]`.
- `getPlatformFindToolDefinition(cwd, { sessionId })` and
  `getPlatformLsToolDefinition(cwd, { sessionId })` — same failure-safe shape
  as grep (undefined when unbooted; `ToolDefinition<any, any>` built from the
  registry exports; renderCall/renderResult from a template definition, since
  find/ls renderers are object methods like bash/grep's).

`agent-session.ts` `_buildRuntime`:

```ts
const platformFind = getPlatformFindToolDefinition(this._cwd, { sessionId: this.sessionManager.getSessionId() });
if (platformFind) baseToolDefinitions.find = platformFind;
const platformLs = getPlatformLsToolDefinition(this._cwd, { sessionId: this.sessionManager.getSessionId() });
if (platformLs) baseToolDefinitions.ls = platformLs;
```

## 7. What Stays a Stub / Legacy

| Area | Status |
|---|---|
| `NodeFileSystemService` write surface (`write`/`append`/`delete`/`mkdir`/`copy`/`move`/`watch`) | Unchanged stubs (Step 1.9 candidate) |
| write/edit tool migrations | Legacy |
| `.gitignore` respect on the platform find path | fd's feature; the platform glob applies the explicit ignore list + the dotfile rule instead (see §8) |
| Hidden-file search on the platform find path | fd `--hidden` is not reproduced; `*` patterns do not match dot-entries (standard glob) |
| Permission enforcement | Declaration only; `PermissionService` remains a stub |
| Hot reload / restart / unregister lifecycle | Not implemented |
| Other services (network/auth/cache/events/permissions/logging/configuration/telemetry) | Unchanged not-implemented stubs |

## 8. Assumptions and Compromises

1. **fd is not reproduced exactly.** The platform find path uses standard
   glob semantics (recursive for basename patterns via the `**/` prefix,
   dotfile rule, explicit ignore list). `.gitignore` awareness and `--hidden`
   search remain fd features on the legacy path; the platform path is a plain
   minimatch walk. This is the same honesty as the Step 1.5 compromise (rg
   stayed host-side until the seam existed): behavior is documented, not
   silently different. The find tool's description ("Respects .gitignore")
   is accurate for the default legacy path; the platform path respects the
   explicit ignore patterns the tool passes.
2. **`minimatch` is a new platform dependency** — the first runtime dep
   beyond typebox. It is already a pinned direct dep of the coding-agent, so
   no new transitive surface. Lockfiles are regenerated and reviewed.
3. **The seam's exit code is `number | null`.** Legacy spawn yields `null`
   close codes when killed; `ProcessService` yields `-1` for signal-killed
   processes. The tool's existing checks (`aborted`, `killedDueToLimit`,
   `code !== 0 && code !== 1`) treat both identically.
4. **`GrepOperations.search` is a required member**, not optional: the
   interface only has in-tree implementations (the capability adapter and the
   default), and an optional seam would silently fall back to host spawning —
   the exact thing the seam exists to remove. Third-party custom operations
   are not a shipped surface.
5. **The fs service's glob walk is not fd-fast.** It is a deterministic
   minimatch walk pruned by the literal pattern prefix, `**`-presence, the
   ignore list, and the hidden-dir descent heuristic. Fine for workspace-sized
   trees; performance engineering belongs to the eventual Workspaces
   indexing step.
6. **`list` reports basenames even when recursive** (consumers derive the
   relative path from `path`), keeping `FileStat.name` consistent with
   `stat()`.
7. One kernel per process, boot-time workspace root, per-execution definition
   construction, and the remaining service stubs are all unchanged from
   Steps 1.3–1.7. Step 1.2 contracts hold as-is (they did in every step).
