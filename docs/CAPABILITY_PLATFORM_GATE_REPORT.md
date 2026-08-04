# Pi Capability Platform — the Gate: Design Report (Step 1.10)

**Status:** Implemented and validated
**Based on:** `docs/CAPABILITY_PLATFORM_GATE_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

The **Capability Platform is complete**: the platform is now the **default
execution path for all builtin tools**, not a silent fallback. `_buildRuntime`
no longer builds the legacy set and overlays platform tools per-tool — it
consumes an **atomic seven-tool set** from the capability registry
(`getPlatformAllToolDefinitions`), with the legacy definitions as the explicit
wholesale fallback (`resolveBaseToolDefinitions`' single `??`). Mixed
platform/legacy session state is now impossible.

The step also retires both named sub-items from the Step 1.9 report:

1. **Adapter dedup**: the seven near-identical `buildXToolDefinition`
   functions in `platform-runtime.ts` are gone, replaced by one generic
   `buildPlatformToolDefinition` driven by a per-tool `PLATFORM_TOOL_SPECS`
   table (capability id, label, tool name, template, execution-metadata
   builder, and edit's `prepareArguments`/`renderShell` extras). The seven
   `getPlatformXToolDefinition` accessors stay (the test surface and a
   granular host API) but are now thin table lookups.
2. **Manifest↔tool description pinning**: every capability's `provides.tool`
   prose (`description`, `promptSnippet`, `promptGuidelines`) is now sourced
   from a module-scope tool template (reused by `init`), so the hand-copied
   strings that had drifted (read's truncated description, find's stale
   promptSnippet, write's dropped promptGuidelines, edit's missing
   promptGuidelines) can never drift again — enforced by a fixture asserting
   manifest↔template equality for all seven tools.

| Component | Implementation | Minimal scope honored |
| --- | --- | --- |
| Atomic tool set | `buildAllToolDefinitionsFromKernel(kernel, cwd, opts)` (kernel-parametrized, testable) + `getPlatformAllToolDefinitions` (singleton wrapper) — the full `Record<ToolName, ToolDef>` only when the kernel is booted **and** all seven tool exports are available; a partial registry (capability init failure) returns undefined with a warning | One decision point; no per-tool fallback |
| Gate resolution | `resolveBaseToolDefinitions(cwd, opts, buildLegacy)` — `platform ?? legacy`; `_buildRuntime` now: `_baseToolsOverride` → override; else `resolveBaseToolDefinitions(...)`; the seven per-tool overlay blocks are deleted | Platform-first construction, legacy as the developer/edge fallback |
| Adapter dedup | `PlatformToolSpec` table + one generic `buildPlatformToolDefinition` (execute closure, renderers, error mapping) | Pure dedup; behavior byte-identical (all existing tests pass unchanged) |
| Manifest sourcing | Each capability hoists `createXToolDefinition("")` to module scope; `provides.tool` reads `description`/`promptSnippet`/`promptGuidelines` from it; `init` reuses the same template | Discovery metadata only — nothing consumes `provides.tool` prose for behavior |
| Fixture | `test/platform-gate.test.ts` — 14 new tests: atomic set (all seven / partial registry / unbooted / singleton lifecycle), platform-first vs legacy identity, manifest↔template equality ×7, and a session-level platform-backed read through the agent loop | Pins the coupling + the gate decision |

## 2. Validation Results

- `packages/coding-agent/test/platform-gate.test.ts` — **14/14 pass** (new):
  atomic set — all seven definitions when fully booted (names, renderers,
  edit's `prepareArguments` + `renderShell: "self"`), undefined for a kernel
  missing one export (no mixed state), undefined when unbooted, singleton
  all-seven-then-undefined across `ensurePlatformRuntime`/`shutdownPlatformRuntime`;
  `resolveBaseToolDefinitions` — platform objects (identity ≠ legacy) when
  booted, the exact legacy objects (identity =) when not booted; manifest↔
  template equality for all seven tools (name, description, parameters,
  promptSnippet, promptGuidelines); session integration — an AgentSession
  built while the kernel is booted executes a `read` through the platform set
  via the agent loop (file content in the tool result).
- Existing behaviour unchanged: `test/platform-runtime.test.ts` (12/12),
  `test/write-edit-capability.test.ts` (13/13), `test/bash-capability.test.ts`
  (13/13), `test/grep-capability.test.ts` (15/15), `test/find-ls-capability.test.ts`
  (12/12), `test/tools.test.ts` (74/74 — the legacy paths still work through
  the fallback), `test/agent-session-concurrent.test.ts` (7/7),
  `test/agent-session-dynamic-tools.test.ts` (4/4),
  `test/edit-tool-legacy-input.test.ts` (8/8), all other `agent-session-*`
  root files (28 passed / 18 skipped across 8 files), the full `test/suite`
  (52 files / **198 tests**), and `session-service` / `settings-service` /
  `session-id-readonly` (25/25).
- Repo-wide `npm run check` exit 0: biome (999 files — +1 for the new test),
  pinned-deps, ts-imports, shrinkwrap, install-lock, `tsgo --noEmit`,
  browser-smoke.
- No lockfile changes this step (no new dependencies).
- `packages/platform` untouched — no dist rebuild needed (tests resolve the
  platform from src via vitest aliases; dist is unchanged and current).

## 3. Architectural Decisions

1. **The platform tool set is atomic — all seven or none.** The gate's
   definition of "the platform is the default execution path" is that the
   builtin set is a single unit. Each tool's export was previously gated
   independently (a broken read capability could silently leave the session
   on legacy read + platform bash/grep); `buildAllToolDefinitionsFromKernel`
   returns undefined if **any** export is missing, so `_buildRuntime` can
   never produce a half-platform session.
2. **The gate is one `??` in one exported function.** `resolveBaseToolDefinitions`
   is the single decision point, exported so the inversion is unit-testable
   without booting a session: platform objects (identity ≠ legacy) when
   booted, the very legacy objects (identity =) when not — proving the
   fallback is wholesale, not a per-tool rebuild.
3. **Kernel-parametrized set building.** `buildAllToolDefinitionsFromKernel`
   takes the kernel as a parameter so the atomicity rules can be tested
   against arbitrary kernels (e.g. a full set, a set missing one capability)
   without touching the process singleton; the singleton wrapper is a thin
   one-liner.
4. **The failure behavior is decided, not emergent.** A kernel boot failure
   already warned and kept the runtime undefined (Step 1.3 decision); the
   gate extends that to the only remaining silent case — a booted kernel with
   a missing tool export now warns loudly and falls back wholesale. A kernel
   failure can never fail a session, and a degraded half-platform session
   cannot silently exist.
5. **Manifest prose is sourced from the tool templates, not copied.** The
   manifest's `provides.tool` fields are discovery metadata (the kernel only
   queries `provides` *keys*); sourcing them from a module-scope template —
   the same template `init` already built per call — makes the drift the 1.9
   report flagged structurally impossible, and the fixture pins it.
6. **The generic builder keeps the adapter-boundary `any`.** The seven
   builders' per-tool `AgentToolResult<Details>` casts were already erased by
   the `ToolDefinition<any, any>` return type at the boundary; the unified
   builder's `AgentToolResult<any>` loses nothing (the same documented
   wrapper.ts-boundary typing), so no per-tool builder body remains.

## 4. Compromises

1. **A genuinely broken single tool now takes the whole set to legacy.** The
   atomicity rule trades per-tool degradation for coherence; the builtins are
   declared together and failures are loud, so this is an edge case, not a
   steady state.
2. **The granular `getPlatformXToolDefinition` accessors remain.** They are
   the test surface and a granular host API, and they now share the generic
   builder, but they are no longer used by the session — a small API surface
   with one remaining purpose (tests/hosts). Kept rather than churned, per
   the "always ask before removing" rule.
3. **The fallback is still a full legacy tool set**, including the legacy
   paths' settings-capture semantics (construction-time
   `autoResizeImages`/`shellPath`/`shellCommandPrefix`). The gate inverts the
   *sourcing*; it does not port the settings transport.

## 5. Technical Debt (Intentional)

| Debt | Why accepted | Retirement |
| --- | --- | --- |
| `permissions.fs: "write"` (and the read-side declarations) are declaration only — `PermissionService` remains a stub | Enforcement is a later step; the gate ships the *sourcing*, not the policy | With the PermissionService (Approval Framework / policies) |
| `fs.move` has no EXDEV fallback; `NodeFileSystemService.watch` stub; remaining service stubs (network/auth/cache/events/permissions/logging/configuration/telemetry) | Unchanged from Steps 1.3–1.9 | Workspaces / Event System steps |
| The seven granular `getPlatformXToolDefinition` accessors are now test/host-only | Tests assert the granular fallback contract | When a host contract replaces them |
| Per-execution definition construction remains (each capability builds a fresh definition per call via `executePlatformTool`) | Walking skeleton; execution-time cwd + injected operations | Re-evaluate when hosts need shared definitions |
| `packages/platform/dist` must be rebuilt for the running binary when platform src changes | dist is gitignored; release builds it | Release pipeline (`npm run build`) |

## 6. Deferred Functionality (Explicit Non-Goals, Confirmed Unimplemented)

Permission **enforcement**, hot reload/restart, event-bus replay / background
dispatcher, model providers, per-session runtimes, host contracts, the
remaining service stubs, and any Planning/Workspaces/Event-System work (all
designed, none started). No changes to the Step 1.2 event model or contracts;
no contract gaps surfaced this step.

## 7. Assumptions

As listed in the design document (§8): the platform tool set is atomic
(all seven or none); fallback is a hard requirement (a kernel failure never
fails a session); manifest prose sourcing is a manifest change, not a behavior
change (nothing consumes `provides.tool` prose for behavior); the granular
accessors stay; the generic builder's `any` result type is the same erased
boundary type the seven builders already produced; the Step 1.2 contracts hold
as-is (they did).

## 8. Recommended Next Step

The **Capability Platform is complete** — the ROADMAP's first feature is
done. The gate is closed: the platform is the default execution path for all
builtin tools (read/bash/grep/find/ls/write/edit), the tool set is atomic,
the fallback is explicit and loud, and the adapter layer is as deduplicated as
the capabilities themselves.

The roadmap's next feature is **Planning** (`docs/PLANNING_ARCHITECTURE.md`,
ROADMAP item 2), whose §16 already names its platform integration: a
persisted, versioned, schema-validated **Plan object** owned by the runtime;
pipeline stages as `orchestration`-category capabilities with manifests and
strict JSON exports; a deterministic kernel-side scheduler; plan lifecycle
events over the platform event bus. The substrate the platform steps built is
exactly what Planning needs: the registry/resolver/lifecycle for stage
capabilities, `fs` for plan persistence, `session` for plan-scoped state, and
the tool surface for actions.

The natural first sub-step (mirroring this feature's build order — contracts
and a schema-validated artifact before stages): the **Plan object** — the
TypeBox schema for `Goal → Plan → Task` (§4 of the design), validation, a
versioned persistence layer on the fs service, and the events
(`plan.created`/`plan.approved`/`plan.replanning`/`plan.completed`).
Workspaces (`docs/WORKSPACE_ARCHITECTURE.md`) — whose full substrate (fs
glob/list + write surface, process, settings, session) is already in place —
and the Event System are the designed consumers after that.
