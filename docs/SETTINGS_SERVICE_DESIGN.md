# Pi Capability Platform — SettingsService Extraction behind SettingsManager (Step 1.6)

**Status:** Design (pre-implementation)
**Based on:** `docs/GREP_CAPABILITY_REPORT.md` §8 (recommended next step), `docs/RUNTIME_KERNEL_REPORT.md` §8 (service-extraction roadmap), `docs/CAPABILITY_PLATFORM_CONTRACTS.md` §5.4 (SettingsService contract), `docs/GREP_CAPABILITY_DESIGN.md` (Step 1.5 design)
**Date:** 2026-02-08

---

## 1. Objective

Give the platform its **first config-bearing service**: a real
`SettingsService` implementation that adapts the existing
`SettingsManager`, injected into the kernel's `KernelServiceProvider` at
`bootPlatformRuntime` (the `NodeProcessService` precedent). Capabilities read
settings through `ctx.settings.get(...)` instead of riding them through
execution metadata.

This retires the `metadata` settings transport debt carried since Step 1.4
(`read`'s `autoResizeImages`, `bash`'s `commandPrefix`/`shellPath` ride
`_buildRuntime → getPlatform*ToolDefinition options → execution metadata →
capability execute` today), and is the substrate `docs/WORKSPACE_ARCHITECTURE.md`
(roadmap item 3) needs for workspace-scoped configuration.

This is still incremental migration, not the finished platform. No building
ahead: only the read side of the contract is implemented; the write/observe
side stays "not implemented" (walking-skeleton discipline, mirroring
`NodeProcessService.spawnPty`).

---

## 2. What Stays the Same (from Steps 1.3–1.5)

| Aspect | Status |
|---|---|
| Kernel component boundaries (registry/resolver/loader/lifecycle/service-provider/event-bus) | Unchanged (one additive `settings` option in `KernelServiceProviderOptions`) |
| `read`, `bash`, `grep` capabilities and their adapter shape | Unchanged in structure; read/bash swap their settings source |
| Step 1.2 contracts (capability/runtime/service/event/error/identifier/schema) | **Frozen** — no contract change this step |
| Event model | Untouched |
| Failure-safe consumption pattern (`ensurePlatformRuntime` + fallback) | Unchanged; `ensurePlatformRuntime` gains an optional `{ settingsManager }` |
| Adapter-over-rewrite pattern (per-execution definition construction) | Kept |
| `AgentSession.executeBash`, extension `ctx.exec`, legacy `createAllToolDefinitions` | Legacy path, untouched (settings still captured there at build time) |
| Manifest validation at registration (`Value.Parse` against `CapabilityManifestSchema`) | read/bash manifests updated and must pass the same gate |

---

## 3. The Transport Being Retired

Today the settings travel a bridge:

```
_buildRuntime (settingsManager.getImageAutoResize() / getShellCommandPrefix()
               / getShellPath())
  → getPlatformReadToolDefinition(cwd, { autoResizeImages }) /
    getPlatformBashToolDefinition(cwd, { commandPrefix, shellPath })
  → ToolExecutionContext.metadata { autoResizeImages, commandPrefix, shellPath }
  → capability execute reads toolCtx.metadata.*
```

`metadata` is meant for per-execution extras (read's `model`, bash's
`extensionContext`/`onUpdate`); settings are not extras — they are
configuration. This step moves them behind the service boundary the Step 1.2
contracts already define (`ctx.settings`), so capabilities stop reading
configuration out of an ad-hoc bucket.

---

## 4. The SettingsService Implementation

### 4.1 Location and shape

`packages/coding-agent/src/platform/settings-service.ts` (new):

```ts
export class SettingsManagerService implements SettingsService {
  constructor(manager: SettingsManager) { this.manager = manager; }

  get<T>(path: string, defaultValue?: T): T | undefined { ... }
  getAll(): Record<string, unknown> { ... }
  async load(): Promise<void> { await this.manager.reload(); }
  async save(): Promise<void> { await this.manager.flush(); }

  // Walking-skeleton: not implemented (see §4.3).
  set(...): Promise<void> { notImplemented("set"); }
  registerSchema(...): void { notImplemented("registerSchema"); }
  subscribe(...): () => void { notImplemented("subscribe"); }
  subscribeAny(...): () => void { notImplemented("subscribeAny"); }
  reset(...): Promise<void> { notImplemented("reset"); }
  getSettingsPath(...): string { notImplemented("getSettingsPath"); }
}
```

- `get` walks the dotted path over the **effective** settings snapshot
  (global + project merged + `applyOverrides`), returning `defaultValue` when
  the value is `undefined` — the same fallback semantics as every
  `SettingsManager` getter (`getImageAutoResize()` is
  `settings.images?.autoResize ?? true`).
- `getAll` returns that snapshot as a plain object.
- `load`/`save` map to the manager's own persistence lifecycle
  (`reload()`, `flush()`) — thin, honest mappings over machinery the manager
  already owns.
- The adapter lives in **coding-agent**, not the platform package, because
  `SettingsManager` imports host code (`config.ts`, `utils/paths.ts`,
  `http-dispatcher.ts`, pi-tui/pi-ai types). The kernel stays generic; the
  host supplies the implementation through `KernelServiceProviderOptions`,
  exactly like `fs`/`process`.

### 4.2 One additive accessor on SettingsManager

The manager's merged `settings` field and `deepMergeSettings` are
module-private, so the adapter needs a public snapshot accessor:

```ts
// settings-manager.ts (additive; no behavior change)
getEffectiveSettings(): Settings {
  return structuredClone(this.settings);
}
```

This is the **only** change to `settings-manager.ts`. No getter is touched;
the existing 100+ typed getters stay authoritative for the legacy path.

### 4.3 Walking-skeleton scope (what stays "not implemented")

`set`, `registerSchema`, `subscribe`, `subscribeAny`, `reset`,
`getSettingsPath` throw `PlatformError` `NOT_IMPLEMENTED`, mirroring
`NodeProcessService.spawnPty`. Why each is deferred:

| Method | Why deferred |
| --- | --- |
| `set` | `SettingsManager` persists through per-field typed setters + modified-field tracking; a generic dotted-path setter would need to replicate that machinery |
| `registerSchema` | No schema registry in `SettingsManager` |
| `subscribe` / `subscribeAny` | No change-notification emitter in `SettingsManager` |
| `reset` | Tied to the write machinery |
| `getSettingsPath` | Storage paths are private to `FileSettingsStorage` |

The pilots (read/bash/grep) need `get` only. Workspaces (the driver for the
write/observe side) is where `set`/`subscribe` land.

---

## 5. Capability Changes (read, bash)

### 5.1 read (`tool.read`)

- `execute` now sources `autoResizeImages` from the injected service:

  ```ts
  const autoResizeImages = ctx.settings.get<boolean>("images.autoResize", true) ?? true;
  ```

  (was `toolCtx.metadata.autoResizeImages`). `metadata.model` stays — that is
  a genuine per-execution extra.
- Manifest: `requires.services: ["fs", "settings"]`,
  `permissions: { fs: "read", config: "read" }`.

### 5.2 bash (`tool.bash`)

- `execute` now sources shell config from the injected service:

  ```ts
  const shellPathSetting = ctx.settings.get<string>("shellPath");
  const shellPath = shellPathSetting ? normalizePath(shellPathSetting) : undefined;
  const commandPrefix = ctx.settings.get<string>("shellCommandPrefix");
  ```

  `normalizePath` (tilde expansion, separators) is applied in the adapter —
  preserving `SettingsManager.getShellPath()`'s exact behavior, per the
  Step 1.4 decision that "adapter state stays host-side".
- Manifest: `requires.services: ["process", "settings"]`,
  `permissions: { process: "spawn", config: "read" }`.

### 5.3 grep (`tool.grep`)

Unchanged — grep has no settings. Its manifest keeps
`services: ["fs"]`, and the settings stub in its context is never touched.

### 5.4 The `config` permission key

`permissions.config: "read"` declares settings access; the permission
vocabulary has no `settings` key and `config` ("Configuration access") is the
closest semantic fit. Declaration-only — `PermissionService` remains a stub,
unchanged from Steps 1.3–1.5.

---

## 6. Wiring

### 6.1 `KernelServiceProviderOptions.settings`

```ts
// packages/platform/src/kernel/service-provider.ts (additive option)
export interface KernelServiceProviderOptions {
  fs?: FileSystemService;
  process?: ProcessService;
  events?: EventBusService;
  settings?: SettingsService;   // new
  workspaceRoot?: string;
}
// constructor: this.settings = options.settings ?? (notImplementedService("settings") as SettingsService);
```

The default remains the not-implemented stub, so `createRuntime` callers that
don't supply settings keep today's behavior (kernel tests included).

### 6.2 `bootPlatformRuntime`

```ts
// platform-runtime.ts
export async function ensurePlatformRuntime(
  options: PlatformRuntimeOptions = {},
): Promise<KernelRuntime | undefined> {
  // unchanged idempotent guard, then:
  bootPromise = bootPlatformRuntime(options);
}

async function bootPlatformRuntime(options: PlatformRuntimeOptions) {
  const settings = new SettingsManagerService(
    options.settingsManager ?? SettingsManager.inMemory(),
  );
  const kernel = createRuntime({
    builtins: [readCapability, bashCapability, grepCapability],
    services: { workspaceRoot: process.cwd(), settings },
  });
  ...
}
```

- `SettingsManager.inMemory()` is the default when no manager is supplied —
  pure (no disk I/O, no file locks) and safe for a process singleton.
- `createAgentSession` (sdk.ts) passes the session's real manager:
  `await ensurePlatformRuntime({ settingsManager })`.

### 6.3 `_buildRuntime`

The platform calls drop the settings options (the legacy fallback path keeps
them — `createAllToolDefinitions` still captures settings at build time):

```ts
const platformRead = getPlatformReadToolDefinition(this._cwd, {
  sessionId: this.sessionManager.getSessionId(),
});
const platformBash = getPlatformBashToolDefinition(this._cwd, {
  sessionId: this.sessionManager.getSessionId(),
});
```

`PlatformReadOptions` loses `autoResizeImages`; `PlatformBashOptions` loses
`commandPrefix`/`shellPath`; the read/bash execution metadata no longer
carries them.

---

## 7. Behavior Parity and Known Limits

| Concern | Status |
| --- | --- |
| Setting values and defaults | Identical: same paths (`images.autoResize`, `shellCommandPrefix`, `shellPath`), same defaults (`true` / `undefined`) |
| `shellPath` normalization | Identical: `normalizePath` applied in the bash adapter (same function the manager's `getShellPath()` uses) |
| When values are read | Platform path reads per-**execution** from the runtime's settings service (fresher than the legacy build-time capture); legacy path unchanged |
| Multiple sessions in one process | One kernel per process ⇒ the settings service binds to the first `createAgentSession`'s manager; a second session in the same process keeps the first manager. Pre-existing "one kernel per process, boot-time workspace root" limitation (Step 1.3 §11.1, deferred "per-session runtimes"), documented not fixed |

---

## 8. Tests

1. **`test/settings-service.test.ts` (new)**
   - `get` dotted-path resolution over a real `SettingsManager.inMemory(...)`
     (nested path, top-level path, missing path → default, missing path with
     no default → `undefined`);
   - `getAll` returns the effective merged snapshot (global + project
     overrides);
   - `load` re-reads from storage (`reload`), `save` awaits the write queue
     (`flush`);
   - `set`/`subscribe`/`subscribeAny`/`reset`/`getSettingsPath`/
     `registerSchema` throw `PlatformError` (`NOT_IMPLEMENTED`);
   - kernel integration: `createRuntime({ services: { settings: service } })`
     injects the service into the capability context
     (`ctx.settings.get` works, stub not used).
2. **`test/platform-runtime.test.ts` (read)** — `bootReadKernel` injects a
   settings service; a spy-settings test asserts read's execute reads
   `images.autoResize` from `ctx.settings` (transport retired, not metadata);
   metadata `{}` executions still succeed.
3. **`test/bash-capability.test.ts`** — `bootBashKernel` injects a settings
   service; "honors commandPrefix and shellPath from execution metadata"
   becomes "...from the settings service" (`SettingsManager.inMemory`
   with `shellCommandPrefix`); the consumption test that passed
   `commandPrefix` through options becomes one that boots the runtime with a
   settings manager and executes with none.
4. **`test/grep-capability.test.ts`** — unchanged (grep touches no settings;
   its stub-context tests keep passing).
5. **`packages/platform/test/kernel.test.ts`** — one new test: a supplied
   `settings` override is injected through the capability context; the
   existing "unknown services are not-implemented stubs" test is untouched
   (default still a stub).

---

## 9. What Stays a Stub / Legacy

| Area | Status |
|---|---|
| `SettingsService.set` / `registerSchema` / `subscribe` / `subscribeAny` / `reset` / `getSettingsPath` | Not implemented (walking skeleton) |
| `SessionService` | Stub — the Step 1.7 extraction |
| Remaining stubs (network/auth/cache/permissions/logging/configuration/telemetry) | Unchanged |
| `NodeFileSystemService` beyond read/stat/exists/etc. | Unchanged (`glob`/`list` etc. throw) |
| Permission enforcement | Declaration only |
| Per-session runtimes / workspace-scoped configuration | Deferred (Workspaces) |
| Other tool migrations (write/edit/find/ls) | Remain legacy |

---

## 10. Assumptions

1. One kernel per process; the settings service binds to the boot-time
   manager (first `createAgentSession`); per-session runtimes stay deferred.
2. Dotted-path `get` over the effective merged snapshot is the right
   semantics; no path escaping / array indexing needed by the pilots.
3. `load → reload()` and `save → flush()` are acceptable honest mappings of
   the contract's lifecycle methods for the skeleton.
4. `permissions.config: "read"` is the closest declaration of settings read
   access until a finer `PermissionKey` exists.
5. The Step 1.2 contracts hold as-is (they do — the extraction is host-side).
