# Planning (ROADMAP Step 2) — Planning Capability Skeleton + Stage Contract: Design Report (Step 2.3)

**Status:** Implemented and validated
**Based on:** `docs/planning/PLANNING_SKELETON_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

The generic planning-stage pattern every later stage (2.4+) follows, delivered
as a new `@earendil-works/pi-platform/planning` implementation subpath: a stage
is an `orchestration`-category capability defined by a stage contract
(`systemPrompt` + `inputs` + `outputSchema`, §6.2), run by a shared strict-JSON
runner (§11: validate → one retry → degrade/abort), routed to a purpose-chosen
model independently of the session model, persisting through the Step 2.2
`PlanStore`, and emitting the planning event surface over the shared
`EventBusService`. A walking skeleton — one trivial **non-AI** stage — runs
end-to-end.

| Component | Location | What it is |
| --- | --- | --- |
| Planning events | `packages/platform/src/planning/events.ts` (new) | `plan.created`/`plan.approved`/`plan.replanning`/`plan.completed` type consts + event factory helpers |
| Stage contract + runner + routing + wrapper | `packages/platform/src/planning/stage.ts` (new) | `PlanningStage`, `PlanningStageRunContext`, `StageModelRouting`, `resolveStageModel`, `runStrictJsonStage`, `definePlanningStageCapability` |
| Trivial stage | `packages/platform/src/planning/trivial.ts` (new) | `createDraftPlanStage` (`orchestration.plan.create`) |
| Re-exports | `packages/platform/src/planning/index.ts` (new) | `/planning` subpath surface |
| Subpath | `packages/platform/package.json` | `@earendil-works/pi-platform/planning` |
| Tests | `packages/platform/test/planning-stage.test.ts` (new) | 8 tests |

Key behaviors:

- **The §11 strict-JSON runner** `runStrictJsonStage` is the only way an AI stage
  produces output: parse/validate against `outputSchema`, one retry with the
  validation errors appended to the prompt, then skip (optional) or abort with a
  stage-naming diagnostic (mandatory). Fully implemented and unit-tested with
  fake completions, so 2.4 just binds a real model function into it.
- **Per-stage model routing** (`StageModelRouting` + `resolveStageModel`):
  a config keyed by stage → model, resolved at the stage contract level,
  explicitly independent of the session's selected model (cheap stages cheap,
  expensive stages capable).
- **Stages are real capabilities**: `definePlanningStageCapability` wraps a
  stage in a static `orchestration` manifest (`requires.services: ["fs",
  "events"]`, no peers) + a factory whose `init` builds a workspace-scoped
  `PlanStore` from `ctx.fs.getWorkspaceRoot()` and exposes `{ stage: { run } }`.
  This closes the loop the 2.2 report flagged — the store is reached through the
  capability context.
- **Walking skeleton end-to-end**: registering `createDraftPlanStage` in a
  `KernelRuntime`, initializing, and running it produces a schema-valid draft
  `Plan`, persists it on disk, and emits `plan.created` on the bus.

## 2. The Decisions This Step Made (from the design)

1. **Placement:** a new `/planning` implementation subpath (not root-exported, like
   `/kernel`); no contract module modified — `PlatformEventType` stays frozen (the
   planning event consts live in the feature, not the contract layer).
2. **Stage contract shape:** `{ id, category, name, description, systemPrompt?,
   inputs, outputSchema, mandatory, modelKey?, run }` (the §6.2 triple plus §11
   mode and routing key).
3. **Strict-JSON runner with §11 degradation** built now, tested with fake
   completions so 2.4 slots a real model in.
4. **Model routing keyed by stage, independent of session model.**
5. **Store wired through the capability context** (`ctx.fs` workspace root →
   `PlanStore`), not a new service contract.
6. **Trivial deterministic stage** `orchestration.plan.create` as the walking
   skeleton seed; real pipeline stages replace it in 2.4+.

## 3. Validation Results

- `packages/platform/test/planning-stage.test.ts` — **8/8 pass** (new):
  - strict-JSON runner: ok on first attempt; retry-once-then-ok with validation
    feedback in the prompt; abort-mandatory with a stage-naming diagnostic after
    2 attempts; degrade-optional (skip); parses a markdown-fenced JSON response;
  - model routing: per-stage override beats the default; default used when no
    override;
  - end-to-end: a `KernelRuntime` with the trivial stage registered →
    initialize/start → run via exports → `plan.created` emitted, plan persisted
    and readable back through a fresh `PlanStore` (equal to the stage output), and
    the capability is `orchestration`-category and `ready` in the registry.
- Full `packages/platform` vitest suite — **99/99 pass** (was 91, +8).
- Repo-wide `npm run check` **green**: biome, pinned-deps, ts-imports,
  shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke.
- `dist` not rebuilt: `/planning` is gitignored build output and no consumer
  imports it yet (Step 1.4 precedent).

## 4. Scope Notes

- Step 2.3 was the container, runner, routing, event surface, and one trivial
  stage. Real AI stages (2.4+), the deterministic downstream stages (2.5–2.10),
  the approval gate (2.11), the scheduler + coding-agent entry point (2.12) are
  later steps and were not built.
- The stage is not yet wired into the coding-agent boot; it lives in the platform
  and is demonstrated with a `KernelRuntime` in tests. The coding-agent entry
  point lands at 2.12.
- No changelog entry: `packages/platform` has no `CHANGELOG.md` (created in
  Step 1.2; prior planning step reports added none).

## 5. Recommended Next Step

**Step 2.4 — Goal Analysis + Clarification Gate.** The stage container, strict-JSON
runner, model routing, event surface, and store wiring (2.1–2.3) are now in
place, so the first **real AI stage** can be built on them. Per
`docs/planning/PLANNING_STEPS.md`, 2.4 lands `GoalAnalysis` as an
`orchestration` capability — a `PlanningStage` with a `Goal` `outputSchema`,
routed to a purpose-chosen cheap model via the 2.3 `resolveStageModel` (through
`runStrictJsonStage` for §11 containment) — plus the deterministic Clarification
Gate with bounded rounds. That validates the 2.3 container against the first
real model-driven stage and the `Goal` schema (2.1).
