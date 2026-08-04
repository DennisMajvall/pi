# Planning (ROADMAP Step 2) — Scheduler + execution overlay + end-to-end: Design Report (Step 2.12)

**Status:** Implemented and validated
**Based on:** `docs/planning/PLAN_SCHEDULER_E2E_DESIGN.md` (this step's design)
**Date:** 2026-02-10

---

## 1. What Was Built

Closes the Planning feature: request → approved plan → minimal execution. Four new
`/planning` modules ship the 2.12 gate: the execution overlay (strictly separate from
plan content, §5/§12), the minimal deterministic scheduler (§6.5), the layered
complexity detection + hybrid entry trigger, and the end-to-end orchestrator that
chains the 2.4–2.11 stages into an approved plan persisted on disk. The designated TUI
plan view is **not** in scope (2.13).

| Component | Location | What it is |
| --- | --- | --- |
| Execution overlay | `packages/platform/src/planning/execution-overlay.ts` (new) | `ExecutionTaskStatus`, `ExecutionOverlayEntry`, `ExecutionOverlay` + pure transitions (`attachOverlay`/`markRunning`/`completeTask`/`failTask`) |
| Deterministic scheduler | `packages/platform/src/planning/scheduler.ts` (new) | `schedulerReady`/`schedulerNext` (priority then id), `resolveRequiredCapabilities`, `executeTask`, `executeApprovedPlan` |
| Complexity detection | `packages/platform/src/planning/complexity.ts` (new) | `deterministicPreFilter` + `aiComplexityVerdict` composed by `assessComplexityLayered` |
| Entry trigger | `packages/platform/src/planning/trigger.ts` (new) | `evaluateTrigger` — explicit `/plan` + auto-engage |
| Orchestrator | `packages/platform/src/planning/orchestrator.ts` (new) | `runPlanningPipeline` chaining 2.4–2.11; `ClarificationRequiredError` |
| Re-export | `packages/platform/src/planning/index.ts` | all added to `/planning` |
| Tests | `packages/platform/test/scheduler-e2e.test.ts` (new) | 22 tests (18 + 4 aggregate-behavior) |
| Free-model e2e | `packages/platform/test/planning-e2e-free-model.test.ts` (new) | 1 opt-in e2e test (skipped without `OPENROUTER_API_KEY`) |

No contract-module changes — `TaskSchema.additionalProperties: false` already forbids
execution state on plan content; the overlay is a separate side-table.

Key behaviors:

- **Execution overlay.** `ExecutionTaskStatus = pending | ready | running | blocked |
  failed | done`. `attachOverlay(plan)` builds one per-task entry (attempts 0,
  priority 0 unless overridden). Transitions are pure (return a new overlay) and record
  attempts / responsible executor / started–ended / result / error. The overlay never
  touches the `Plan` — an attached overlay leaves `PlanSchema` intact
  (`Object.hasOwn(task, "status") === false`).
- **Minimal deterministic scheduler.** `schedulerReady(t) = status pending ∧ every
  `dependsOn` `done`; `schedulerNext` = argmin by **(priority, then id)** — total,
  reproducible, no model in execution order. `resolveRequiredCapabilities` resolves a
  task's `requiredCapabilities` through an injected resolver, reporting missing ids
  (never silently skipping). `executeTask` marks `running`, invokes the resolved
  capability, records the result/`done` or the error/`failed`; `executeApprovedPlan`
  walks the DAG serially to all-done (parallel/resume/retry is roadmap #7).
- **Layered complexity detection.** Deterministic pre-filter (prompt length, tool-call
  volume, token/scope estimate, multi-step hints) short-circuits below a floor
  threshold with no model call; otherwise the cheap-model AI judgment (routed like Goal
  Analysis) returns a strict `{ planWarranted, reason? }` verdict. The cheap judgment
  stays off the expensive later-stage models.
- **Hybrid entry trigger.** `/plan <request>` always engages (`mode: "explicit"`);
  otherwise auto-engage only when the layered check warrants a plan. Simple prompts
  never route through planning.
- **End-to-end orchestrator.** `runPlanningPipeline(request, stages, ctx)` drives the
  full §6.3 chain (Goal Analysis → Clarification Gate → Strategy → Constraints (+
  never-upgrade downgrade) → Decomposition → Dependency Builder → Critic → Optimizer →
  Validation → Metrics → Review gate), persists the **approved** plan once, and emits
  `plan.created` + `plan.approved`. A goal needing clarification with no answers throws
  `ClarificationRequiredError` (carrying the questions); a validation failure throws
  (a pipeline bug). Model routing + completions are injected (host-built stages; fakes
  in tests) — the platform adds no settings surface.

## 2. The Decisions This Step Made (from the design)

1. **Execution state is a pure side-table, never plan content.** The overlay keys by
   plan + task id; `priority` lives here, not on `Task`. `TaskSchema` already enforces
   the split.
2. **The scheduler is kernel-side code, not a capability** (§6.5). It consumes the
   approved plan's DAG plus an injected capability resolver; the LLM contributes
   nothing to execution order. `executeTask` is deliberately a walking skeleton —
   autonomous multi-task orchestration is roadmap #7.
3. **Layered complexity, cheapest first.** The deterministic pre-filter avoids a model
   call for trivial prompts; the AI layer (cheap model, same routing family as Goal
   Analysis) runs only when the pre-filter crosses its floor.
4. **Hybrid trigger stays policy-deterministic: `/plan` always wins**; auto only on
   layered warrant. The TUI `/plan` offering is 2.13.
5. **The orchestrator assembles the plan in memory and persists once**, threading the
   §6.7 stage inputs, rather than round-tripping an empty draft through the store and
   fabricating interim revisions. Only the `approval` revision is recorded on the fresh
   plan.
6. **Model wiring stays host-side.** `runPlanningPipeline` accepts pre-built stages
   (completion + routing injected); real binding from settings (`planning.models.*`) is
   the coding-agent wiring, out of `packages/platform`.
7. **The shared runner grounds every AI stage with its exact output schema, and contains
   completion failures (`stage.ts`).** The prose stage prompts only *name* the schema
   ("Return valid JSON matching the Goal schema"); the free-model e2e showed a model
   that does not already know the schema invents a different shape and fails strict
   validation even after the retry-error loop. `runStrictJsonStage` now appends the
   actual `outputSchema` (the very JSON schema `Value.Check` validates against) to the
   prompt — the platform-side stand-in for the runtime's generation-constrained sampling
   (`packages/ai` constrained-sampling.ts), which the injected opaque `StageCompletion`
   cannot use. A completion *throw* (network error, empty upstream reply) is now
   contained as a failed attempt (§11): an optional stage degrades, a mandatory stage
   aborts with the diagnostic, instead of crashing the whole pipeline.

## 3. Validation Results

- `packages/platform/test/scheduler-e2e.test.ts` — **22/22 pass** (18 structural + 4
  aggregate-behavior):
  - the execution overlay: preview + status/attempts/executor/result, transitions
    (running/done/failed), and that an attached overlay never adds execution fields to
    the plan (`PlanSchema` still valid);
  - the scheduler: `ready(t)` from `dependsOn`; `next` by priority then id (incl. the
    id tiebreak and the "no task ready" case); capability resolution incl. missing ids;
    `executeTask` result/failure recording; `executeApprovedPlan` walking a dependency
    DAG to all-done in dependency order;
  - complexity/trigger: pre-filter short-circuit and escalation; the layered AI
    composition on the routed cheap model; `/plan` always engages, a trivial prompt does
    not;
  - the orchestrator: full 2.4–2.11 chain → a validated, scored, **approved** plan
    persisted on disk with `plan.created`+`plan.approved` emitted; an unconfigured AI
    stage aborts with "no model configured"; a waived approval policy auto-approves;
    a clarification-needing goal throws `ClarificationRequiredError`; with answers it
    proceeds and the approved plan walks to a capability execution;
  - **aggregate behavior (what a user would expect, not just functions working):**
    `[A]` the optimizer's valid improved plan replaces the draft with a real dependency
    DAG and `executeApprovedPlan` runs it in dependency order (root first, join last);
    `[C]` hard/resource constraints flow through the pipeline and deterministically
    downgrade the policy (deep→medium depth, parallel→serial, specialists/dual off);
    `[D]` a user `/plan` always engages even for a trivial request, and the
    complexity auto-trigger engages for a complex prompt and skips a trivial one (no
    pipeline run).
- `packages/platform/test/planning-e2e-free-model.test.ts` — **1 opt-in e2e test**
  (skipped unless `OPENROUTER_API_KEY` is set; verified **green** here against the
  free OpenRouter nemotron model). Drives the real `runPlanningPipeline` with a real
  model, then asserts **static/structural** checks — that a plan was made the correct
  way, not that it is "good": status `approved`, `PlanSchema`-valid, well-formed
  unique task ids, `dependsOn` referencing only existing tasks, the deterministic
  `validatePlan` passing (schema + acyclicity + coverage), an `approval` revision,
  and on-disk persistence. The free model follows the strict output schemas because
  the platform runner now grounds each stage with the exact JSON schema (decision 7);
  the harness adds only client-style retries for free-tier transience — no hand-
  authored per-stage hints. This e2e validated the grounding fix: the first schema-
  grounding run failed with uncontained "empty completion" throws until the runner
  containment landed.
- `packages/platform/test/planning-stage.test.ts` — **+1 test**: a completion throw is
  contained (§11) — an optional stage degrades and a mandatory stage aborts with the
  diagnostic, never crashing the pipeline.
- Full `packages/platform` vitest suite — **217 passed + 1 skipped (the e2e) = 218**
  when the key is absent; **218/218** when the key is present.
- Repo-wide `npm run check` **green** (exit 0): biome `--error-on-warnings`, pinned-deps,
  ts-imports, shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke.
- `dist` not rebuilt: gitignored build output, no consumer yet (Step 1.4 precedent).

## 4. Scope Notes

- Step 2.12 was the deterministic scheduler + execution overlay + layered complexity/
  hybrid trigger + the end-to-end orchestrator. Full autonomous multi-task execution
  (parallel scheduling, resume, retry, progress, verification-driven replanning) is
  roadmap #7; persisting the overlay for resume is deferred to #7 too.
- The dedicated TUI plan view is **2.13** (~`packages/tui` interactive widget on top of
  the 2.11 platform core + 2.12 trigger/orchestrator). Not built here.
- The orchestrator's Clarification Gate path is a walking skeleton: it throws
  `ClarificationRequiredError` for unanswered blocking questions and proceeds with
  provided answers / low-confidence assumptions at the bounded rounds; the full
  re-run-Goal-Analysis-only loop is bounded by 2.4's gate.
- No changelog entry: `packages/platform` has no `CHANGELOG.md` (Step 1.2 precedent).

## 5. Recommended Next Step

**Step 2.13 — TUI Plan View**, the designated follow-up that re-checks the
Planning-complete gate (2.12) with the interactive review surface in place: a
`packages/tui` plan-list + drill-in DAG/task view driving the 2.11
`renderPlanDag`/`user_edit`/`plan.review` core and the 2.12 `/plan` flow. After 2.13
closes Planning, the next feature is roadmap **#3 (Workspaces)** or, if execution depth
is wanted first, a lean-slice handoff to **#7 (Task/Execution Engine)**.
