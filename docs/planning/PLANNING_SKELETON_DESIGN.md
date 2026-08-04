# Planning (ROADMAP Step 2) — Planning Capability Skeleton + Stage Contract: Design (Step 2.3)

**Status:** Design (pre-implementation)
**Based on:** `docs/PLANNING_ARCHITECTURE.md` §6.2 (stage contract), §11 (error containment), §16 (stages as `orchestration` capabilities, events); `docs/planning/PLANNING_STEPS.md` Step 2.3; `docs/planning/PLAN_STORE_REPORT.md` (Step 2.2 recommended next step)
**Package:** `@earendil-works/pi-platform` (new `/planning` subpath)
**Date:** 2026-02-08

---

## 1. Objective

Establish the generic planning-stage pattern every later stage (2.4+) follows:
a stage is an `orchestration`-category capability defined by a **stage contract**
(`systemPrompt` + `inputs` + `outputSchema`), executed by a **shared strict-JSON
runner** (validate → one retry → degrade/abort, §11), with **per-stage model
routing** resolved independently of the session's selected model, persisting
through the Step 2.2 `PlanStore` and emitting the planning **event surface**
over the existing `EventBusService`.

Deliverable: a walking skeleton — one trivial **non-AI** stage runs end-to-end
as an `orchestration` capability, persists via the 2.2 store, and emits a
`plan.created` event. This step establishes the container and the shared helper;
real AI stages (2.4+) and full pipeline wiring + the coding-agent entry point
(2.12) are later steps.

## 2. Placement

Implementation (runtime behavior), so it lives outside the contract modules —
a new `/planning` implementation subpath beside `/kernel`, mirroring how the
plan contracts (2.1) and the store (2.2) are organized:

| Artifact | Location |
| --- | --- |
| Planning events (`plan.created`/`approved`/`replanning`/`completed`) | `packages/platform/src/planning/events.ts` (new) |
| Stage contract + strict-JSON runner + model routing + stage-capability builder | `packages/platform/src/planning/stage.ts` (new) |
| The trivial non-AI stage | `packages/platform/src/planning/trivial.ts` (new) |
| Re-exports | `packages/platform/src/planning/index.ts` (new) |
| Subpath | `@earendil-works/pi-platform/planning` (package.json) |

Like `/kernel`, the `/planning` subpath is **not** re-exported from the package
root (implementation-only, avoids root name collisions). No contract module is
modified; `PlatformEventType` is deliberately left untouched (the planning
event type consts are defined in `planning/events.ts`, not frozen into the
contract layer). The store is reached through the stage **capability context**
(`ctx.fs` workspace root → `PlanStore`, `ctx.events` → event bus), closing the
loop the 2.2 report flagged.

## 3. Decisions

### 3.1 The generic stage contract (§6.2)

```ts
interface PlanningStage<Out extends TSchema> {
  id: string;                    // capability id: <category>.<name>
  category: "orchestration";
  name: string;
  description: string;
  systemPrompt?: string;         // AI stages only; deterministic stages omit it
  inputs: readonly string[];     // structured inputs from prior stages (never the full conversation, §6.7)
  outputSchema: Out;             // strict JSON output schema
  mandatory: boolean;            // §11: optional → skip, mandatory → abort on repeated failure
  modelKey?: string;             // model-routing key (defaults to the stage id)
  run: (input, ctx) => Promise<unknown>;  // deterministic, or AI-backed via the shared runner
}
```

`PlanningStageRunContext` carries the workspace-scoped `PlanStore` (built from
`ctx.fs.getWorkspaceRoot()` at init) and the `EventBusService`, so a stage can
persist and emit without knowing the kernel.

### 3.2 The shared strict-JSON runner (§11)

`runStrictJsonStage({ completion, systemPrompt, userPrompt, outputSchema, model, mandatory })`
encodes §11 exactly and is the only way an AI stage (2.4+) produces output:

- call the `completion` (injected; a real model call in 2.4+, fake in tests) →
  parse JSON → `Value.Check` against `outputSchema`;
- on validation failure, **retry once**, appending the validation errors to the
  prompt;
- on the second failure, **degrade deterministically**: skip if not `mandatory`,
  abort with a diagnostic naming the stage + errors if `mandatory`.

The runner is fully implemented and unit-tested now (with fake completions) so
2.4 slots a real model function into it.

### 3.3 Per-stage model routing

`StageModelRouting = { default: string; stages?: Record<string, string> }`, and
`resolveStageModel(stage, routing) = routing.stages?.[modelKey ?? id] ?? routing.default`.
The routing map is a config keyed by stage, resolved **at the stage contract
level**, explicitly independent of the session's selected model — so a cheap
judgment stage (2.4) can run on a cheap model while later stages run on capable
ones. In the skeleton the routing object is supplied by the caller (the
coding-agent wiring in 2.4+ binds real model ids); a `DEFAULT_STAGE_MODEL_ROUTING`
placeholder establishes the shape.

### 3.4 Stage-as-capability wrapper

`definePlanningStageCapability(stage)` maps a `PlanningStage` onto the platform
pattern: a static manifest (category `orchestration`, `requires.services:
["fs","events"]`, no peer capabilities) plus a factory whose `init` builds the
workspace `PlanStore`, and exposes a `{ stage: { run } }` export. Registering it
in a `KernelRuntime` makes the stage discoverable/loadable like any other
capability — the §16 "stages as capabilities" invariant.

### 3.5 The trivial stage

`createDraftPlanStage` (`orchestration.plan.create`) is the 2.3 walking-skeleton
stand-in. It is **deterministic** (non-AI): given `{ id?, summary }` it builds a
schema-valid draft `Plan` (draft status, empty policy-driven defaults), persists
it via `PlanStore.save` (which validates `PlanSchema`), and emits `plan.created`.
This exercises create → persist → event end-to-end and is the seed later stages
fill in.

### 3.6 Event surface

`planning/events.ts` defines the four type consts (`plan.created`,
`plan.approved`, `plan.replanning`, `plan.completed`) plus `planCreatedEvent`/
`planApprovedEvent`/`planReplanningEvent`/`planCompletedEvent` factories over the
existing `createEvent` envelope (`planning` source, `Workspace` scope), emitting
through the shared `EventBusService` already in `CapabilityContext.events`.

## 4. Public API

```ts
// stage.ts
interface PlanningStage<Out extends TSchema> { ... }
interface PlanningStageRunContext { store: PlanStore; events: EventBusService; sessionId?: SessionId }
type StageCompletion = (req: { systemPrompt: string; userPrompt: string; model: string }) => Promise<string>;
type StrictJsonResult<Out> = { kind: "ok"; output: Static<Out>; attempts } | { kind: "degraded"; error?; attempts } | { kind: "aborted"; error; attempts };
runStrictJsonStage<Out>(opts): Promise<StrictJsonResult<Out>>;
interface StageModelRouting { default: string; stages?: Record<string, string> }
resolveStageModel(stage, routing): string;
definePlanningStageCapability<Out>(stage): BuiltinCapability;

// events.ts
EVENT_PLAN_CREATED / APPROVED / REPLANNING / COMPLETED
planCreatedEvent(payload) / planApprovedEvent / planReplanningEvent / planCompletedEvent

// trivial.ts
createDraftPlanStage: PlanningStage<typeof PlanSchema>
```

## 5. Validation performed (this step)

- `packages/platform/test/planning-stage.test.ts` (new): strict-JSON runner
  (ok / one-retry-then-ok / abort-mandatory / degrade-optional), model routing
  (override + default), and the full end-to-end walking skeleton — a
  `KernelRuntime` with the trivial stage registered, `initialize`/`start`, run
  the stage via its exports, asserting the `plan.created` event was emitted and
  the plan was persisted (readable back through `PlanStore`).
- Full `packages/platform` vitest suite + repo-wide `npm run check` green.
