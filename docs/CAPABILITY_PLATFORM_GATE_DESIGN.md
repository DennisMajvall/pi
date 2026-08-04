# Pi Capability Platform — the Gate (Step 1.10)

**Status:** Design (pre-implementation)
**Based on:** `docs/WRITE_EDIT_MIGRATION_REPORT.md` §8 (recommended next step), `docs/ROADMAP.md` (Step 1.10)
**Date:** 2026-02-08

---

## 1. Objective

Close the **Capability Platform** roadmap item with the gate: the platform
becomes the **default execution path for all builtin tools**, not a silent
fallback. Three pieces:

1. **Invert `_buildRuntime`.** Today it starts from the legacy definitions
   (`createAllToolDefinitions`) and overlays platform ones when the kernel is
   booted. The gate inverts that: traffic-first construction — the platform
   tool set is the primary source, legacy is the developer/edge fallback.
2. **Retire the platform-runtime adapter duplication** (the Step 1.9 report's
   named sub-item): the seven near-identical `buildXToolDefinition` functions
   collapse into one generic builder driven by a per-tool spec table — the
   same deduplication the capabilities already shed via `executePlatformTool`.
3. **Pin the manifest↔tool description coupling** (the Step 1.9 report's
   named sub-item): the manifests' `provides.tool` descriptions are
   hand-copied strings that have drifted from the tools' descriptions. Source
   them from the tool templates (one module-scope template per capability,
   reused by `init`), so drift is impossible, and add a fixture asserting
   manifest↔template equality as a regression guard.

After this step the **Capability Platform is complete** (ROADMAP item 1):
the platform is the default execution path for read/bash/grep/find/ls/write/
edit, newest-first, and the roadmap moves to Planning.

## 2. What Stays the Same (from Steps 1.3–1.9)

| Aspect | Status |
|---|---|
| Kernel component boundaries (registry/resolver/loader/lifecycle/service-provider/event-bus) | Unchanged |
| The seven capabilities and their per-execution behavior | Unchanged (byte-identical on the platform path) |
| Step 1.2 contracts (capability/runtime/service/event/error/identifier/schema) | **Frozen** — no contract change this step |
| Event model | Untouched |
| Failure-safe boot (`ensurePlatformRuntime` catch → warn → runtime stays undefined) | Kept; the gate makes the fallback *atomic* and explicit |
| Adapter-over-rewrite pattern | Kept |
| `executePlatformTool` shared helper | Unchanged, still used by the capabilities |
| Manifest validation at registration (`Value.Parse` against `CapabilityManifestSchema`) | Unchanged; manifests keep passing |
| `_baseToolsOverride` (tests/harness) | Unchanged — it still wins over both platform and legacy |
| Tool-definition identity: platform-built and legacy definitions are behaviorally identical by design | Unchanged — the gate is about *sourcing*, not behavior |

## 3. Why These Pieces Belong Together

The Step 1.9 report §8 names the gate as the next step: the entire builtin
set is migratable, the fs service covers both sides, the platform ships its
first write permission — the only remaining work is making the platform the
*default* instead of a fallback. The gate is a single inversion of
`_buildRuntime`, but its two named sub-items block it: the seven adapter
functions are the exact duplication the capabilities just shed, and the
manifest descriptions sit two update-cycles stale. Doing all three together
closes the loop the 1.9 report opened.

## 4. The Gate: platform-first sourcing, atomic fallback

### 4.1 The decision is one atomic `??`

`_buildRuntime` currently builds the legacy set and overlays platform tools
per-tool. The gate replaces that with a single all-or-nothing decision in
`platform-runtime.ts`:

```ts
export function resolveBaseToolDefinitions(
	cwd: string,
	options: { sessionId?: string },
	buildLegacy: (cwd: string) => Record<ToolName, ToolDef>,
): Record<ToolName, ToolDef> {
	return getPlatformAllToolDefinitions(cwd, options) ?? buildLegacy(cwd);
}
```

`getPlatformAllToolDefinitions` returns the **full seven-tool
`Record<ToolName, ToolDef>`** when the kernel is booted **and** every one of
the seven tool exports is available; it returns `undefined` otherwise. The
`??` means the platform tool set is atomic — either all seven tools come from
the platform, or all seven come from legacy. **No mixed state is possible**
(a partial platform / partial legacy session was possible before, because
each tool's export was gated independently).

`_buildRuntime` becomes:

```ts
const baseToolDefinitions = this._baseToolsOverride
	? Object.fromEntries(/* as today */)
	: resolveBaseToolDefinitions(
			this._cwd,
			{ sessionId: this.sessionManager.getSessionId() },
			(cwd) =>
				createAllToolDefinitions(cwd, {
					read: { autoResizeImages },
					bash: { commandPrefix: shellCommandPrefix, shellPath },
				}),
		);
```

The seven per-tool `getPlatformXToolDefinition` overlay blocks are deleted.

### 4.2 Failure behavior (decided, documented, tested)

The gate decides what happens when the kernel fails to boot mid-session:

1. **Boot failure at startup** — `ensurePlatformRuntime`'s catch already
   warns and keeps the runtime undefined; `getPlatformAllToolDefinitions`
   returns undefined and the session is built on legacy. The walking
   skeleton never fails a session because the kernel failed.
2. **Boot failure mid-session (reload)** — `reload()` re-runs `_buildRuntime`,
   which re-runs the same decision against the current runtime state: platform
   definitions if the kernel is still booted, legacy otherwise. The fallback
   is loud, not silent: the boot catch warns, and `getPlatformAllToolDefinitions`
   warns when the kernel is up but a tool export is missing (partial registry).
3. **Partial registry** — the only way a booted kernel has a missing tool
   export is a capability init failure. `getPlatformAllToolDefinitions`
   detects this and returns undefined (atomic fallback), with a `console.warn`
   naming the missing tool, so a silently-degraded half-platform session
   cannot happen.

### 4.3 The kernel-parametrized core

To keep the atomicity testable without touching the process-level singleton,
the set-building logic is kernel-parametrized and the singleton wrapper is
thin:

```ts
export function buildAllToolDefinitionsFromKernel(
	kernel: KernelRuntime | undefined,
	cwd: string,
	options: PlatformToolSetOptions = {},
): Record<ToolName, ToolDef> | undefined {
	if (!kernel) return undefined;
	const definitions: Partial<Record<ToolName, ToolDef>> = {};
	for (const spec of PLATFORM_TOOL_SPECS) {
		const tool = kernel.capabilities.getExports<{ tool: ToolCapabilityExport }>(spec.capabilityId)?.tool;
		const context = kernel.capabilities.getContext(spec.capabilityId);
		if (!tool || !context) {
			console.warn(chalk.yellow(`[platform] tool "${spec.label}" unavailable; falling back to legacy paths`));
			return undefined;
		}
		definitions[spec.toolName] = buildPlatformToolDefinition(spec, tool, context, cwd, options);
	}
	return definitions as Record<ToolName, ToolDef>;
}

export function getPlatformAllToolDefinitions(cwd, options) {
	return buildAllToolDefinitionsFromKernel(getPlatformRuntime(), cwd, options);
}
```

## 5. Dedup: one generic builder (sub-item a)

The seven `buildXToolDefinition` functions share an identical shape: name,
label, description, promptSnippet, promptGuidelines, parameters from the
export; a `execute` closure that calls `tool.execute` with the capability
context, reading `{ model }` (read) / `{ extensionContext, onUpdate }`
(bash) into `metadata`; and renderers from the template. The only per-tool
differences are the `metadata` content, the result-cast detail type, and
edit's extra `prepareArguments` + `renderShell: "self"`.

A per-tool spec table captures exactly those differences:

```ts
interface PlatformToolSpec {
	readonly capabilityId: CapabilityId;
	readonly label: string;
	readonly toolName: ToolName;
	readonly template: ToolDefinition<any, any>;
	readonly metadata: (
		extensionContext: ExtensionContext | undefined,
		onUpdate: AgentToolUpdateCallback | undefined,
	) => Record<string, unknown>;
	readonly extras?: Pick<ToolDefinition, "prepareArguments" | "renderShell">;
}
```

and one generic builder replaces the seven:

```ts
function buildPlatformToolDefinition<TDetails>(
	spec: PlatformToolSpec,
	tool: ToolCapabilityExport,
	context: CapabilityContext,
	cwd: string,
	options: PlatformToolSetOptions,
): ToolDefinition<any, any> {
	return {
		name: tool.definition.name,
		label: spec.label,
		description: tool.definition.description,
		promptSnippet: tool.definition.promptSnippet,
		promptGuidelines: tool.definition.promptGuidelines,
		parameters: tool.definition.parameters,
		prepareArguments: spec.extras?.prepareArguments,
		renderShell: spec.extras?.renderShell,
		execute: async (_toolCallId, params, signal, onUpdate, extCtx) => {
			const result = await tool.execute(params, {
				capability: context,
				signal: signal ?? new AbortController().signal,
				sessionId: sessionId(options.sessionId ?? "unknown"),
				cwd,
				metadata: spec.metadata(extCtx, onUpdate),
			});
			if (!result.success) {
				throw new Error(result.error ?? `${spec.label} failed`);
			}
			return result.output as unknown as AgentToolResult<TDetails>;
		},
		renderCall: spec.template.renderCall as unknown as ToolDefinition<any, any>["renderCall"],
		renderResult: spec.template.renderResult as unknown as ToolDefinition<any, any>["renderResult"],
	};
}
```

The seven exported `getPlatformXToolDefinition` accessors stay (they are used
by every capability test and remain a granular host API) but each becomes a
thin single-tool lookup over the same table — no duplicated builder bodies.

## 6. Manifest description sourcing (sub-item b)

Each capability file hoists its template to module scope and reads the
manifest's `provides.tool` prose from it, instead of hand-copying:

```ts
const toolTemplate = createReadToolDefinition("");

export const readManifest: CapabilityManifest = {
	...
	provides: {
		tool: {
			name: "read",
			description: toolTemplate.description,
			parameters: readSchema,
			promptSnippet: toolTemplate.promptSnippet,
			promptGuidelines: toolTemplate.promptGuidelines,
		},
	},
	...
};
```

`init` reuses the same module-scope template (it already built an identical
one per call). This is safe because the manifest's `provides.tool`
description is discovery metadata only — nothing in the kernel consumes it
for behavior (the registry query checks `provides` *keys*, not values), and
the actual tool definitions use `tool.definition.description` from the
export, which is already template-derived.

Downstream manifest deltas from the pinning (all additive, all the "drift"
the report flagged):
- read / ls / bash / grep: `description` becomes the full template text
  (e.g. read gains the truncation note and image-type list).
- find: `promptSnippet` becomes `"Find files by glob pattern (respects
  .gitignore)"` (template) instead of the stale `"Find files by glob pattern"`.
- write: gains `promptGuidelines: ["Use write only for new files or complete
  rewrites."]` (template) that the hand-copy dropped.
- edit: `promptSnippet`/`promptGuidelines` become the template's canonical
  values.

## 7. What Stays a Stub / Legacy

| Area | Status |
|---|---|
| `NodeFileSystemService.watch` | Unchanged stub (event-system step) |
| Remaining service stubs (network/auth/cache/events/permissions/logging/configuration/telemetry) | Unchanged |
| Permission **enforcement** (`permissions.fs` is declaration only; `PermissionService` remains a stub) | Unchanged — the gate is about sourcing, not enforcement |
| Legacy tool paths (`createAllToolDefinitions` / `createXToolDefinition`) | Kept as the explicit fallback when the kernel is unavailable |
| `file-mutation-queue` | Legacy, unchanged |
| Hot reload / restart / unregister lifecycle | Unchanged |
| `.gitignore` on the platform find path, fd parity | Unchanged from Step 1.8 |

## 8. Assumptions and Compromises

1. **The platform tool set is atomic (all seven or none).** This is the gate's
   definition of "the platform is the default execution path": a partial
   platform session is a pre-gate state. If one capability's init fails, the
   whole set falls back rather than degrade. Edge case: a genuinely broken
   single tool now takes the whole set to legacy, but the builtins are
   declared together and the failure is loud.
2. **Fallback is a hard requirement, not just a convenience.** A kernel boot
   failure must never take down the agent session; the gate makes the
   fallback explicit and atomic rather than silently per-tool.
3. **Manifest description sourcing is a manifest change, not a behavior
   change.** `provides.tool.description` is discovery metadata; sourcing it
   from the template is the intended drift-pinning. No test asserts the old
   hand-copied strings.
4. **`getPlatformXToolDefinition` granular accessors stay.** They are the
   test surface and a granular host API; the session consumes the atomic set.
   Kept as thin table lookups, so they add no duplicated builder bodies.
5. **The generic builder's `TDetails` is a per-spec compile-time cast.** The
   result object is the same at runtime; the type argument preserves the
   per-tool detail type on the platform-built definition (identical to the
   current seven builders, which each cast to their own `AgentToolResult<X>`).
6. Step 1.2 contracts hold as-is; no contract gap surfaced this step.