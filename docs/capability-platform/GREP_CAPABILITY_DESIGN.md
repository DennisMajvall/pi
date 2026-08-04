# Pi Capability Platform — Third Capability (grep) with a Peer-Capability Dependency (Step 1.5)

**Status:** Design (pre-implementation)
**Based on:** `docs/capability-platform/BASH_CAPABILITY_REPORT.md` §8 (recommended next step), `docs/capability-platform/BASH_CAPABILITY_DESIGN.md` (Step 1.4 design), `docs/capability-platform/RUNTIME_KERNEL_REPORT.md` §8 (service-extraction roadmap)
**Date:** 2026-02-08

---

## 1. Objective

Migrate the `grep` builtin tool onto the capability platform as the **third**
migrated capability (after `read` and `bash`), and make it the **first
capability with a peer-capability dependency** (`requires.capabilities`).

The Step 1.4 report's §8 priority list, item 1: *"Extract a third capability
with a peer-capability dependency and no new service (e.g. `grep`/`find`/`ls`
on `fs`) — this exercises the `requires.capabilities` edge, which no migrated
capability uses yet."*

`grep` is chosen over `find`/`ls` for two reasons:

1. **No `FileSystemService` extension needed.** `GrepOperations`' seam is
   `isDirectory` + `readFile`; both map to already-implemented `NodeFileSystemService`
   methods (`stat`, `readBytes`). `find` would require `fs.glob` and `ls`
   would require `fs.list` — both currently throw "not implemented". Extending
   the fs service is deferred to whichever extraction actually needs it.
2. **A genuine peer relationship exists with `tool.read`.** `grep` reads file
   contents for context lines; `read` is the platform's file-reading
   capability. `find`/`ls` have no natural peer capability.

This is still incremental migration, not the finished platform. No building
ahead.

---

## 2. What Stays the Same (from Steps 1.3 and 1.4)

| Aspect | Status |
|---|---|
| Kernel component boundaries (registry/resolver/loader/lifecycle/service-provider/event-bus) | Unchanged |
| `read` and `bash` capabilities and their consumption wiring | Unchanged (except one additive export, §4.2) |
| Step 1.2 contracts (capability/runtime/service/event/error/identifier/schema) | **Frozen** — no contract change this step |
| Event model | Untouched |
| Failure-safe consumption pattern (`ensurePlatformRuntime` + fallback) | Extended to grep, same shape |
| Adapter-over-rewrite pattern (per-execution definition construction) | Kept; no "definition factory" refactor |
| `AgentSession.executeBash` and extension `ctx.exec` | Legacy path, untouched |
| Manifest validation at registration (`Value.Parse` against `CapabilityManifestSchema`) | The grep manifest must pass the same gate |

---

## 3. Why Not find / ls (and Why grep Is the Cheapest)

| Candidate | Operations seam | fs methods needed | Seam coverage | Peer dependency |
| --- | --- | --- | --- | --- |
| `grep` | `isDirectory`, `readFile` | `stat`, `readBytes` (both implemented) | Partial — rg search stays in the tool | Natural: `tool.read` |
| `find` | `exists`, `glob` | `glob` (not implemented) | Full — custom `glob` bypasses fd | None natural |
| `ls` | `exists`, `stat`, `readdir` | `list` (not implemented) | Full | None natural |

The report's primary ask for the third capability is exercising the
`requires.capabilities` edge. Only `grep` has a natural peer, and it needs
zero fs-service work. Its one compromise is that the ripgrep search process is
spawned by the tool itself via `node:child_process` — the `GrepOperations`
seam does not cover the search backend, so the platform path still runs rg
host-side (see §6 debt).

---

## 4. The grep Capability

### 4.1 Manifest

Static declaration (discovery without loading), registered alongside `read`
and `bash`:

```ts
{
  schemaVersion: 1,
  id: "tool.grep",
  version: "1.0.0",
  category: "tool",
  provides: { tool: { name: "grep", description, parameters: grepSchema,
                      promptSnippet, promptGuidelines } },
  requires: {
    services: ["fs"],
    capabilities: [{ id: "tool.read", version: "*" }],   // peer dependency
  },
  permissions: { fs: "read" },
  compatibility: { runtime: ">=0.83.0", peers: {} },
  metadata: { name: "Grep Tool", description, tags: ["builtin", "search"] },
}
```

`grepSchema` is already exported from `tools/grep.ts` (additive export; no
logic change), mirroring how `read` uses `readSchema` and `bash` uses
`bashSchema`.

`requires.capabilities` is the first real use of the peer edge: the
`SimpleCapabilityResolver` post-order DFS places `tool.read` before
`tool.grep` in `initializationOrder`; `KernelLifecycleManager.initializeAll`
inits in that order; `shutdownAll` runs the reverse order (grep unloads before
read). The dependency is **hard** (not optional): if `tool.read` is not
registered, grep's init fails with a clear error and the capability lands in
the `Error` state — the resolver records the missing dependency without
crashing (unchanged resolver semantics, now exercised by a real capability).

### 4.2 The read capability gains one additive export

`grep` needs **full** file contents for context lines. The read *tool*'s
`execute` applies `truncateHead` (2000 lines / 50KB), which would silently
corrupt context blocks for matches deep in large files — grep must not route
`readFile` through the read tool's execute. The read capability therefore
additionally exports a narrow, no-truncation primitive:

```ts
// read-capability.ts, init(ctx) return value
{
  tool,
  readTextFile: async (absolutePath: string): Promise<string> =>
    Buffer.from(await ctx.fs.readBytes(absolutePath)).toString("utf-8"),
}
```

- `CapabilityExports` is `{ [key: string]: unknown }`, so adding an export key
  is **not** a Step 1.2 contract change; existing consumers
  (`getPlatformReadToolDefinition`, tests) read only `exports.tool` and ignore
  the extra key.
- This is the first real **peer-capability consumption**: grep's adapter
  reads `tool.read`'s exports through its own `CapabilityContext.capabilities`
  registry (`ctx.capabilities.getExports<...>(tool.read)`), captured at
  init time after the dependency-aware lifecycle guarantees read is Ready.

### 4.3 Factory adapter

Same shape as the read/bash adapters:

1. `factory(ctx)` — the factory's `init(ctx)`:
   - resolves the peer export once: `ctx.capabilities.getExports<{ readTextFile }>(tool.read)`;
     if missing, throws a clear error (hard dependency), landing grep in
     `Error` state;
   - builds a **template** definition (`createGrepToolDefinition("")`) for
     metadata (name/description/parameters/prompt snippet).
2. The exported `tool.execute(args, toolCtx)`:
   - builds `GrepOperations`:
     - `isDirectory: (p) => (await toolCtx.capability.fs.stat(p)).isDirectory`
       (fs service; `stat` throws on missing paths, matching the tool's
       "Path not found" handling);
     - `readFile: (p) => readExports.readTextFile(p)` (peer capability);
   - builds a **per-execution** definition with the execution `cwd` +
     `{ operations }` (identical adapter pattern to read/bash);
   - executes it (`definition.execute("platform-grep", args, toolCtx.signal, ...)`)
     and maps the result/error into `ToolResult`.
3. `shutdown()` is a no-op.

The ripgrep search itself is untouched: `ensureTool("rg", ...)` + spawn +
JSON streaming all remain in `tools/grep.ts`, exactly as the legacy path runs
them. Only the file-system side (directory check + context-line reads) is
platform-injected.

### 4.4 Consumption wiring

Mirrors bash exactly:

```ts
// platform-runtime.ts
const GREP_CAPABILITY_ID = capabilityId("tool.grep");

builtins: [readCapability, bashCapability, grepCapability],
```

`getPlatformGrepToolDefinition(cwd, { sessionId })`:

1. Returns `undefined` when the kernel is not booted (fallback intact).
2. Reads the `tool.grep` exports + context from the registry.
3. Builds a coding-agent `ToolDefinition<any, any>` (the contract boundary,
   same loose typing as read/bash):
   - metadata from the capability's `definition`;
   - `execute` delegating to `tool.execute` with a `ToolExecutionContext`
     (capability context, signal, sessionId, cwd, empty metadata);
   - `renderCall`/`renderResult` taken from a template
     `createGrepToolDefinition("")` (grep's renderers are object methods on
     the definition, like bash's; the template avoids touching grep.ts).

`_buildRuntime` in `agent-session.ts` gains the grep twin of the read/bash
wiring:

```ts
const platformGrep = getPlatformGrepToolDefinition(this._cwd, {
  sessionId: this.sessionManager.getSessionId(),
});
if (platformGrep) baseToolDefinitions.grep = platformGrep;
```

---

## 5. What Stays a Stub / Legacy

| Area | Status |
|---|---|
| `NodeFileSystemService` methods beyond read/stat/exists/etc. | Unchanged stubs (`glob`, `list`, `write`, ...) — find/ls extraction will need them |
| `ProcessService.spawnPty` | Stub (unchanged) |
| Other services (settings/session/network/auth/cache/permissions/logging/configuration/telemetry) | Unchanged not-implemented stubs |
| Permission enforcement | Declaration only (`permissions: { fs: "read" }`); `PermissionService` remains a stub |
| Hot reload / restart / unregister lifecycle | Not implemented |
| Event-bus replay / background-dispatcher roadmap | Not implemented |
| Other tool migrations (write/edit/find/ls) | Remain legacy |
| grep's ripgrep process spawn | Remains inside the tool (see §6) |

---

## 6. Assumptions and Compromises

1. **The rg search process stays host-side.** `GrepOperations` covers only the
   file side of grep; the tool spawns `rg` directly via `node:child_process`
   on both the legacy and platform paths. This mirrors the read step (which
   moved nothing process-related), not the bash step (whose `BashOperations.exec`
   seam covered the whole process lifecycle). Moving the search behind a seam
   would be a rewrite of `tools/grep.ts`, out of scope for an adapter step.
2. **Peer consumption is a hard dependency.** grep cannot init without
   `tool.read`. Boot scenarios that register grep alone fail grep's init with
   a clear error (recorded by the registry + resolver as missing, never a
   crash) — this is the honest semantic of a non-optional `requires.capabilities`
   entry.
3. **`readTextFile` export name/type is a coding-agent-level convention**,
   not a Step 1.2 contract item. Both capabilities live in the same host
   package; the platform contracts only require `CapabilityExports` to be an
   object.
4. **`compatibility.peers` stays empty.** The version constraint on the peer
   rides in `requires.capabilities[].version` (resolver currently ignores
   versions); `checkConflicts` still returns `[]`.
5. One kernel per process, boot-time workspace root, per-execution definition
   construction, and the remaining service stubs are all unchanged from
   Steps 1.3/1.4.
