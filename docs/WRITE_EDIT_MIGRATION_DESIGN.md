# Pi Capability Platform — write/edit Migration + the fs Write Surface (Step 1.9)

**Status:** Design (pre-implementation)
**Based on:** `docs/FIND_LS_SEARCH_SEAM_REPORT.md` §8 (recommended next step), `docs/ROADMAP.md` (Step 1.9)
**Date:** 2026-02-08

---

## 1. Objective

Migrate the **write side** onto the capability platform — the last builtin
tools on the legacy path. Three pieces:

1. **Implement the `NodeFileSystemService` write surface** (`write` / `append`
   / `delete` / `mkdir` / `copy` / `move`) — the operations the contract
   already declares, currently `NOT_IMPLEMENTED` stubs. `watch` stays a stub
   (the event system is a later roadmap feature).
2. **Migrate `write` and `edit`** onto the platform as `tool.write` /
   `tool.edit` capabilities, using the established read/bash/grep/find/ls
   adapter pattern (`WriteOperations` / `EditOperations` backed by the
   injected `FileSystemService`). This exercises the platform's **first
   non-read permission** (`permissions: { fs: "write" }`).
3. **Retire the per-execution definition-execution duplication**: seven
   adapters now build and run a definition per execution with the identical
   try/catch result mapping. A shared helper in
   `src/platform/tool-execution.ts` replaces the five (soon seven) copies —
   the Step 1.8 report's named sub-item.

After this step the **entire builtin tool set** (read, bash, grep, find, ls,
write, edit) is migratable to the platform, the platform's fs surface covers
both sides of the tool surface, and the only remaining gate is Step 1.10
(platform as the default execution path instead of a silent fallback).

## 2. What Stays the Same (from Steps 1.3–1.8)

| Aspect | Status |
|---|---|
| Kernel component boundaries (registry/resolver/loader/lifecycle/service-provider/event-bus) | Unchanged |
| `read`/`bash`/`grep`/`find`/`ls` capabilities and their consumption wiring | Unchanged except the shared execute helper (§5.4) is adopted by all adapters — same semantics, no behavior change |
| Step 1.2 contracts (capability/runtime/service/event/error/identifier/schema) | **Frozen** — no contract change this step; `WriteOptions`/`DeleteOptions`/`MkdirOptions`/`CopyOptions` used as defined |
| Event model | Untouched |
| Failure-safe consumption pattern (`ensurePlatformRuntime` + fallback) | Extended to write/edit, same shape |
| Adapter-over-rewrite pattern | Kept; write/edit are adapters, not rewrites |
| `write`/`edit` legacy tool implementations | Untouched except `writeSchema`/`editSchema` become additive exports (§5.1/§5.2) |
| Manifest validation at registration (`Value.Parse` against `CapabilityManifestSchema`) | New manifests pass the same gate |
| The write tools' `file-mutation-queue` | Unchanged — it serializes mutations inside the tools, both paths |
| `NodeFileSystemService.watch` | Still "not implemented" (event-system step, not fs) |

## 3. Why These Pieces Belong Together

The Step 1.8 report's §8 names the write side as the natural Step 1.9: the
read-only tool set is complete, and `write`/`edit` (plus the
`file-mutation-queue`) are the last builtin tools on the legacy path.
Migrating them requires the fs write surface to be real — same as Step 1.8
needed `glob`/`list` for find/ls. The first `fs: "write"` permission is the
platform's first non-read permission and the last tool-surface migration, so
the Step 1.10 gate ("no builtin left on the legacy path") becomes reachable.

| Piece | Seam it exercises | Service gap it closes |
| --- | --- | --- |
| fs write surface | First implementations of `write`/`append`/`delete`/`mkdir`/`copy`/`move` | Write-side stubs retired (except `watch`) |
| `write` capability | `WriteOperations.mkdir`/`writeFile` backed by `ctx.fs` | First `permissions: { fs: "write" }` |
| `edit` capability | `EditOperations.access`/`readFile`/`writeFile` backed by `ctx.fs` | edit migrates without host `fs/promises` |
| Shared execute helper | One try/catch result mapping for all seven adapters | Step 1.8 report §5 debt (per-execution duplication) |

## 4. FileSystemService: the write surface (platform kernel)

`packages/platform/src/kernel/fs-service.ts` implements the six operations
the contract already declares. The contract itself is untouched. All paths
resolve against the workspace root (existing `resolve()` — absolute paths
pass through, matching the read-side methods).

### 4.1 `write(path, content, options?: WriteOptions)`

- `content: string | Uint8Array`; strings are written with `options.encoding`
  defaulting to `"utf8"` (the contract's `"binary"` maps to node's latin1
  alias, as with any node `writeFile`), binary content passed through as-is.
- `options.mode` passes through to `fs.writeFile`.
- `options.createDirs` (default `false`): `mkdir` the parent directory
  (`recursive: true`) before writing. The write tool itself calls `mkdir`
  explicitly first, so the adapter passes no `createDirs`.

### 4.2 `append(path, content)`

`fs.appendFile` with `"utf-8"` — creates the file when missing, appends
otherwise. (The edit adapter also uses an empty append as its writability
probe, §5.3.)

### 4.3 `delete(path, options?: DeleteOptions)`

`fs.rm` with `recursive` / `force` passed through (both default `false` —
a missing path throws `ENOENT` unless `force`).

### 4.4 `mkdir(path, options?: MkdirOptions)`

`fs.mkdir` with `recursive` / `mode` passed through (recursive defaults
`false`, matching node). The write adapter always passes `recursive: true`.

### 4.5 `copy(source, dest, options?: CopyOptions)`

`fs.cp` with `recursive: true` (handles files and directory trees),
`force: options.overwrite ?? false` (no clobber by default — the contract's
`overwrite` name implies opt-in), `preserveTimestamps` passed through.

### 4.6 `move(source, dest)`

`fs.rename`. Plain rename only (no cross-device copy fallback) — sufficient
for workspace-sized moves; the eventual Workspaces step can grow it.

### 4.7 `watch` — unchanged stub

The event system is a later roadmap feature (`docs/EVENT_ARCHITECTURE.md`),
not an fs-service concern; `watch` keeps throwing `NOT_IMPLEMENTED`.

## 5. Capabilities (coding-agent)

### 5.1 write: `tool.write`

`packages/coding-agent/src/platform/write-capability.ts` — adapter over the
existing `createWriteToolDefinition`, mirroring the read/bash/grep/find/ls
shape:

- Manifest: `requires.services: ["fs"]`, `capabilities: []`,
  `permissions: { fs: "write" }` — **the platform's first write
  permission**; `provides.tool.parameters: writeSchema` (`writeSchema`
  becomes an additive export of `tools/write.ts`).
- `WriteOperations` backed by the injected `FileSystemService`:
  - `mkdir: (dir) => fs.mkdir(dir, { recursive: true })` — the tool always
    creates parent directories,
  - `writeFile: (absolutePath, content) => fs.write(absolutePath, content)`
    (string content, default utf8).

### 5.2 edit: `tool.edit`

`packages/coding-agent/src/platform/edit-capability.ts` — same adapter shape:

- Manifest: `requires.services: ["fs"]`, `capabilities: []`,
  `permissions: { fs: "write" }`, `provides.tool.parameters: editSchema`
  (additive export of `tools/edit.ts`).
- No `tool.read` peer edge: the edit tool's `readFile` operation is backed
  directly by `ctx.fs.readBytes` (the read capability's additive export is
  string-typed `readTextFile`; edit needs a `Buffer` for BOM/line-ending
  preservation, so the fs service is the right backing). Peer edges stay a
  statement of fact: grep needs read's export, edit does not.
- `EditOperations` backed by `ctx.fs`:
  - `access: async (absolutePath)` — the tool's documented error surface is
    `Could not edit file: X. Error code: <code>`, so the adapter reproduces
    the legacy `fs.access(R_OK | W_OK)` semantics from service methods:
      1. `fs.exists` — missing file throws an error with `code: "ENOENT"`
         (matching the legacy message);
      2. **writability probe**: `fs.append(absolutePath, "")` — opening the
         file for append requires write permission, so a read-only file
         (mode 0444) throws `EACCES` (verified against node behavior). The
         probe writes zero bytes; node's open-flag check is the actual
         permission check, identical to `fs.access(..., W_OK)`.
    - Readability is not probed (a mode-0222 file passes `access` and fails
      later at `readFile` with a raw `EACCES` instead of the nice message).
      Documented compromise (§8.3).
  - `readFile: (absolutePath) => Buffer.from(await fs.readBytes(absolutePath))`
    — same as the read capability's file read; a `Buffer` so BOM/CRLF
    preservation in `edit-diff.ts` is byte-identical to the legacy path.
  - `writeFile: (absolutePath, content) => fs.write(absolutePath, content)`.

### 5.3 The shared execute helper: `tool-execution.ts`

All seven adapters end their `execute` with the identical block:

```ts
const definition = createXToolDefinition(toolCtx.cwd, { operations });
try {
  const output = await definition.execute("platform-x", args, signal, undefined, undefined as unknown as ExtensionContext);
  return { success: true, output };
} catch (error) {
  return { success: false, isError: true, error: error instanceof Error ? error.message : String(error) };
}
```

`packages/coding-agent/src/platform/tool-execution.ts` extracts it:

```ts
export type PlatformToolResult =
	| { success: true; output: unknown }
	| { success: false; isError: true; error: string };

export interface ExecutePlatformToolOptions {
	extensionContext?: ExtensionContext;   // read (model), bash (metadata)
	onUpdate?: AgentToolUpdateCallback;    // bash (live updates)
}

export async function executePlatformTool<TInput>(
	definition: ToolDefinition,
	toolCallId: string,
	input: TInput,
	signal: AbortSignal | undefined,
	options: ExecutePlatformToolOptions = {},
): Promise<PlatformToolResult> { ... }
```

The two special cases are options, not forks: read passes its
`{ model }`-shaped `extensionContext`; bash passes the `extensionContext` +
`onUpdate` it already reads from `toolCtx.metadata`. Semantics are
byte-identical to the blocks being replaced — the cleanup is pure
deduplication.

## 6. Consumption Wiring

`platform-runtime.ts`:

- `builtins: [read, bash, grep, find, ls, write, edit]`.
- `getPlatformWriteToolDefinition(cwd, { sessionId })` /
  `getPlatformEditToolDefinition(cwd, { sessionId })` — same failure-safe
  shape (undefined when unbooted; `ToolDefinition<any, any>` built from the
  registry exports).
- The edit definition carries the template's `prepareArguments` (legacy
  `oldText`/`newText` compatibility shim — the agent loop runs it before
  schema validation) and `renderShell: "self"` (the edit tool renders its own
  shell frame), plus template `renderCall`/`renderResult`.

`agent-session.ts` `_buildRuntime`:

```ts
const platformWrite = getPlatformWriteToolDefinition(this._cwd, { sessionId: this.sessionManager.getSessionId() });
if (platformWrite) baseToolDefinitions.write = platformWrite;
const platformEdit = getPlatformEditToolDefinition(this._cwd, { sessionId: this.sessionManager.getSessionId() });
if (platformEdit) baseToolDefinitions.edit = platformEdit;
```

## 7. What Stays a Stub / Legacy

| Area | Status |
|---|---|
| `NodeFileSystemService.watch` | Unchanged stub (event-system step) |
| Remaining service stubs (network/auth/cache/events/permissions/logging/configuration/telemetry) | Unchanged |
| Permission **enforcement** (`permissions.fs` is declaration only; `PermissionService` remains a stub) | Unchanged — this step ships the first write *declaration*, not enforcement |
| write/edit legacy tool paths (`createWriteTool`/`createEditTool`) | Untouched — still the fallback when the kernel is unbooted |
| `file-mutation-queue` | Legacy, unchanged |
| Hot reload / restart / unregister lifecycle | Not implemented |
| `.gitignore` on the platform find path, fd parity | Unchanged from Step 1.8 |

## 8. Assumptions and Compromises

1. **The edit adapter's `access` reproduces the legacy error surface from
   service methods only.** `FileSystemService` has no `access` method (the
   Step 1.2 contract is frozen); `exists` + the empty-append writability
   probe produce the same `ENOENT`/`EACCES` codes the legacy
   `fs.access(R_OK | W_OK)` produced, verified against node. No contract
   change is needed — the adapter composes declared methods.
2. **`fs.append(path, "")` is a side-effect-free probe for write
   permission.** Opening a file for append requires write access, so the
   probe throws `EACCES` for read-only files without writing anything.
3. **Readability is not probed by `access`.** A mode-0222 file passes the
   probe and fails at `readFile` with a raw `EACCES` (the legacy path
   reported it inside the nice "Could not edit file" message). Vanishingly
   rare for an edit target; documented rather than adding a full read to the
   access check.
4. **`copy` defaults to no-overwrite and `move` is plain rename.** The
   contract's `overwrite` name implies opt-in clobbering; `fs.rename` has no
   cross-device fallback. Both are honest minimal implementations for a
   walking skeleton; nothing in-tree consumes them yet (Workspaces will).
5. **The shared execute helper is pure deduplication.** The read/bash
   special cases (model-shaped `extensionContext`, `onUpdate`) become
   options; every adapter's behavior is unchanged (existing tests prove it).
6. **write/edit manifests declare what they do** (`requires.services:
   ["fs"]`, `permissions: { fs: "write" }`, no peer capability) — the peer
   edge stays a statement of fact: grep needs `tool.read`'s export, edit
   does not.
7. One kernel per process, boot-time workspace root, per-execution definition
   construction, and the remaining service stubs are all unchanged from
   Steps 1.3–1.8. Step 1.2 contracts hold as-is.
