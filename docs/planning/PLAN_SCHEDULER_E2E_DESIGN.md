# Planning (ROADMAP Step 2) — Scheduler + execution overlay + end-to-end: Design (Step 2.12)

**Status:** Design (pre-implementation)
**Based on:** `docs/PLANNING_ARCHITECTURE.md` §5 (execution overlay), §6.4/§6.5
(scheduler is code, never the LLM), §12 (scheduling & execution contract), §16
(stages as capabilities); `docs/planning/PLANNING_STEPS.md` Step 2.12;
`docs/planning/PLAN_USER_REVIEW_REPORT.md` (Step 2.11 recommended next step = 2.12)
**Package:** `@earendil-works/pi-platform` (`/planning` subpath)
**Date:** 2026-02-10

---

## 1. Objective

Close the Planning feature: prove the full **request → approved plan → execution**
loop. Four behaviors close the 2.12 gate:

1. **Execution overlay** — per-task runtime state (status, attempts, responsible
   executor, results) kept *strictly separate* from plan content (§5/§12). In-memory
   only (persistence-for-resume is roadmap #7).
2. **Minimal deterministic scheduler** — `ready(t)` from `dependsOn`, `next` by
   priority then id, resolving `requiredCapabilities` to registry capabilities. A
   walking skeleton (§6.5): full parallel/resume/retry is roadmap #7.
3. **Layered complexity detection + hybrid entry trigger** — explicit `/plan` always
   runs the pipeline; otherwise a deterministic pre-filter then a cheap-model AI
   judgment decide whether a prompt warrants a plan before execution.
4. **End-to-end orchestrator** — chains the 2.4–2.11 stages into a validated, scored,
   approved plan persisted on disk, then hands the approved plan to the scheduler for
   a walking-skeleton capability execution.

The dedicated TUI plan view is **not** in scope (Step 2.13).

## 2. Placement & contract

All in the `/planning` subpath. The overlays, scheduler, and complexity/trigger logic
are **kernel-side code** (§6.5 — never capabilities); the orchestrator is a plain
platform function that drives the existing stage capabilities. No `PlanSchema` change:
`Task` keeps zero execution state (§5 enforced by `additionalProperties: false`).

| Artifact | Location | What it is |
| --- | --- | --- |
| Execution overlay | `packages/platform/src/planning/execution-overlay.ts` (new) | `ExecutionTaskStatus`, per-task `ExecutionOverlayEntry`, `attachOverlay` + transition helpers |
| Deterministic scheduler | `packages/platform/src/planning/scheduler.ts` (new) | `schedulerReady`, `schedulerNext` (priority then id), capability resolution, walking-skeleton executor |
| Complexity detection | `packages/platform/src/planning/complexity.ts` (new) | deterministic pre-filter + cheap-model AI verdict (layered) |
| Entry trigger | `packages/platform/src/planning/trigger.ts` (new) | explicit `/plan` + auto-engage routing |
| Orchestrator | `packages/platform/src/planning/orchestrator.ts` (new) | `runPlanningPipeline` chaining 2.4–2.11; `executeApprovedPlan` demo |
| Re-export | `packages/platform/src/planning/index.ts` | all added to `/planning` |
| Tests | `packages/platform/test/scheduler-e2e.test.ts` (new) | ~30 tests |

## 3. Execution overlay (§5, §12)

Per-task runtime state, keyed by `planId` + `taskId`, never merged into `Task`:

```
ExecutionTaskStatus = pending | ready | running | blocked | failed | done
ExecutionOverlayEntry = {
  taskId, status, attempts, responsibleExecutor?,
  priority,        // lower runs first; scheduler orders by priority then id
  startedAt?, endedAt?, result?, error?
}
```

- `attachOverlay(plan, opts)` builds the entry set from `plan.tasks` (all `pending`,
  `attempts 0`, `priority` from an optional map, default 0). `priority` is overlay-only
  (plan content carries none; §6.5 picks by priority then id).
- Transition helpers are pure (return a new overlay/entry): `markRunning`,
  `completeTask`, `failTask` (increments `attempts`, records `error`). The overlay
  holds a `Map<TaskId, ExecutionOverlayEntry>`.

## 4. Minimal deterministic scheduler (§6.5, §12)

`ready(t) = t.dependsOn all done ∧ t.status ∈ {pending, ready, running?}`. For the
walking skeleton `ready` = status `pending` and every `dependsOn` entry `done`.

- `schedulerReady(plan, overlay)` → the ready task ids.
- `schedulerNext(plan, overlay)` → the argmin by **(priority, then id)** over ready
  tasks (the single next task to execute; `parallelExecution` only bounds how many run
  concurrently — #7).
- `resolveRequiredCapabilities(task, resolve)` → `{ resolved: ResolvedCapability[],
  missing: CapabilityId[] }`, where the injected `resolve` maps a `CapabilityId` to a
  `SchedulerCapability` `{ id, manifestId, name, run }`. Missing ids are reported, not
  silently skipped.
- `executeTask(task, capability, overlay, input)` → the walking-skeleton executor:
  marks the task `running`, invokes the resolved capability `run`, records
  `result`, marks `done` (or `failed` + `error` on throw). This is the "resolves a ready
  task to a capability execution" proof; full autonomous multi-task execution is #7.
- `executeApprovedPlan(plan, overlay, resolver, input)` (helper) → loop `schedulerNext`
  → `executeTask` until all tasks `done` (a deterministic serial walk for the demo).

## 5. Layered complexity detection (§6.3.1-adjacent; 2.12 decision)

Two gates, cheapest first:

1. **Deterministic pre-filter** `deterministicPreFilter(input)` — a cheap, pure score
   from prompt length, tool-call volume, a token/scope estimate, and multi-step key
   signals. Below a floor threshold → verdict `{ planWarranted: false }` immediately
   (no model call). Above it → escalate.
2. **AI judgment** `aiComplexityVerdict(input, completion, routing)` — Goal-Analysis-
   family cheap model returns a strict `ComplexityVerdict` (`{ planWarranted, reason? }`)
   via `runStrictJsonStage` (mandatory; a cheap, optional-in-practice stage). The same
   purpose-chosen cheap model backs Goal Analysis (2.4), keeping the cheap judgment off
   the expensive later models.

`assessComplexityLayered(input, { preFilter, completion, routing })` composes the two.

## 6. Entry trigger (confirmed hybrid, 2.12 decision)

`evaluateTrigger({ explicit, request, deps })`:

- `explicit: true` (from `/plan <request>`) → always engage (`mode: "explicit"`).
- otherwise → `assessComplexityLayered`; engage iff the layered check warrants a plan
  (`mode: "auto"`), else `{ engage: false }` (simple prompts never route through
  planning).

The trigger is deterministic in policy (`/plan` always wins; auto only on layered
warrant); the AI layer is cheap. TUI `/plan` offering is 2.13.

## 7. Orchestrator (§6.3 end-to-end)

`runPlanningPipeline(request, stages, ctx)` drives the full pipeline. It threads a
single in-memory plan through the §6.7 inputs, persisting once at the end and emitting
`plan.created` + `plan.approved`:

1. **Goal Analysis** (cheap model) → `goal`.
2. **Clarification Gate** (deterministic): if `needs_clarification` and no answers are
   provided → throws a `ClarificationRequiredError` carrying the questions (the caller
   collects answers and re-runs Goal Analysis only, bounded by 2.4's gate); with
   answers or at the bound it proceeds (recording unknowns as low-confidence
   assumptions).
3. **Execution Strategy** → `policy`; **Constraint Extraction** → families →
   `foldConstraints`; **policy downgrade** (never upgrade, §7) via
   `applyConstraintDowngrade`.
4. **Task Decomposition** → `completeTasks`; **Dependency Builder**
   (`buildDependencyGraph`) → DAG tasks.
5. **Critic** (optional) → critique; assemble draft plan; **Optimizer** (optional) →
   improved plan (subject to acyclicity/schema re-validation).
6. **Plan Validation** (`validatePlan`) — invalid ⇒ throw (pipeline bug).
7. **Metrics** (optional) → `combineMetrics` onto the plan.
8. **Review gate**: `requestReview` → `approvePlan` (required) / `autoApprovePlan`
   (waived), recording the `approval` revision; final status `approved`.

The caller then passes the approved plan to the scheduler (§4) for the walking-skeleton
execution demo. Model routing + completions are injected (`stages` built by the host
from settings, e.g. `planning.models.*`; tests pass fakes) — the platform resolver is a
pure lookup over the injected map (2.3), so the orchestrator adds no settings access.

## 8. Model wiring decision (2.12)

Real model binding stays out of `packages/platform`: the host (coding-agent, later)
builds each AI stage with a `StageCompletion` and `StageModelRouting` derived from user
settings. `runPlanningPipeline` accepts pre-built stages, so the platform remains
testable with a fake completion keyed by model id; the wiring itself is a host concern
(no new platform settings surface in this step).

Because the injected `StageCompletion` is an opaque text-in/text-out black box, the
platform cannot use the runtime's generation-constrained sampling
(`packages/ai` constrained-sampling.ts). So `runStrictJsonStage` embeds the exact
`outputSchema` (the JSON schema `Value.Check` validates against) into every AI stage
prompt, and contains completion throws as failed attempts (§11) so a transport/empty
reply degrades an optional stage or aborts a mandatory one instead of crashing the
pipeline. This is the platform-side stand-in for constrained sampling; the fully robust
fix (threading structured-output generation through `StageCompletion`) is a follow-up.

## 9. Test plan

`test/scheduler-e2e.test.ts`:

- execution overlay: preview the rename (`execution-overlay.ts`) from `plan.tasks`; the
  overlay keys/statuses/attempts; transitions mark running/done/failed; plan content is
  untouched (a `PlanSchema` plan with an overlay never gains execution fields);
- scheduler: `schedulerReady` respects `dependsOn`; `schedulerNext` picks by priority
  then id; capability resolution reports missing ids; `executeTask` records result/failure
  in the overlay; `executeApprovedPlan` walks a small DAG to all-done in dependency order;
- complexity: deterministic pre-filter short-circuits trivial prompts (no model call)
  and escalates long/multi-step ones; the AI layer returns a strict verdict on the routed
  cheap model; layered composes both;
- trigger: `/plan` always engages; a trivial prompt does not (auto off, no model);
- orchestrator: fake completions feed the full 2.4–2.11 chain → a validated, scored,
  **approved** plan persisted on disk, with `plan.created` + `plan.approved` emitted;
  a `required` gate lands in `approved` with an `approval` revision, a waived policy
  auto-approves; a clarification-needing goal throws `ClarificationRequiredError`;
- behavior (aggregate, as a user expects): a valid optimizer output with a real DAG
  replaces the draft and executes in dependency order; hard/resource constraints
  downgrade the policy through the pipeline; `/plan` and the complexity auto-trigger
  both produce a plan while a trivial prompt is left alone;

`test/planning-e2e-free-model.test.ts` (opt-in, skipped unless `OPENROUTER_API_KEY`):

- drives the real `runPlanningPipeline` with the free OpenRouter nemotron model and
  asserts **static** checks that a plan was made the correct way — status `approved`,
  `PlanSchema`-valid, well-formed unique task ids, `dependsOn` only to existing tasks,
  deterministic `validatePlan` passing (schema + acyclicity + coverage), an `approval`
  revision, and on-disk persistence — explicitly not judging whether the plan is
  "good". The harness grounds each stage prompt with its exact output JSON shape (the
  platform prompts describe schemas in prose; the optimizer is left ungrounded and
  degrades to the draft).

- Full platform suite + repo `npm run check` green.
