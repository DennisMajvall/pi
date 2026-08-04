# Planning (ROADMAP Step 2) — Task Decomposition: Design Report (Step 2.7)

**Status:** Implemented and validated
**Based on:** `docs/planning/TASK_DECOMPOSITION_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

Task Decomposition (§6.3.4) — the AI stage that breaks the goal into the
smallest meaningful tasks as an **unordered** list — plus the deterministic
dedupe pass and `maxTasks` budget enforcement from the `PlanningPolicy`, in the
`/planning` subpath.

| Component | Location | What it is |
| --- | --- | --- |
| Task Decomposition stage | `packages/platform/src/planning/task-decomposition.ts` (new) | `taskDecompositionStage(completion, routing?)` → `PlanningStage<typeof TaskDecompositionSchema>` (`orchestration.tasks`) |
| Dedupe / budget / completion | `packages/platform/src/planning/tasks.ts` (new) | `dedupeTasks`, `enforceMaxTasks`, `completeTasks` |
| Re-export | `packages/platform/src/planning/index.ts` | all added to `/planning` |
| Tests | `packages/platform/test/task-decomposition.test.ts` (new) | 7 tests |

Key behaviors:

- **Task Decomposition (`orchestration.tasks`)**: `systemPrompt` is the §6.3.4
  exemplar ("identify work that must exist, never schedule/order/optimize");
  `run` resolves the model, builds the prompt from `TaskDecompositionInput = {
  goal, constraints?, policy, availableCapabilities?, skills? }` (including
  `maxTasks` from the policy), and calls `runStrictJsonStage` with
  `outputSchema: TaskDecompositionSchema`, `mandatory: true`. A §11 abort throws
  the `task_decomposition` diagnostic.
- **Strict "no planning/execution" schema**: each decomposed task is
  `{ id, title, purpose, deliverable }` with `additionalProperties: false`, so an
  output carrying ordering/priority/dependency/parallelism fields is rejected
  (§5/§6.3.4 enforced structurally).
- **Deterministic passes**: `dedupeTasks` (by deliverable, first wins),
  `enforceMaxTasks` (dedupe then cap to `policy.maxTasks`, §6.6), and
  `completeTasks` (fill empty `inputs`/`outputs`/`dependsOn`/`requiredCapabilities`/
  `verification` onto the full 2.1 `Task` shape so it validates against
  `TaskSchema`/`PlanSchema` immediately; the Dependency Builder fills `dependsOn`
  in 2.8).

## 2. The Decisions This Step Made (from the design)

1. **Input set is explicit** (`goal, constraints, policy, capabilities, skills`,
   §6.7) with `maxTasks` from the policy fed into the prompt.
2. **`maxTasks` budget enforced deterministically** after the AI stage
   (`enforceMaxTasks`), so an over-budget model output is bounded by the policy.
3. **The dedupe pass is deterministic** (`dedupeTasks`, first occurrence wins).

## 3. Validation Results

- `packages/platform/test/task-decomposition.test.ts` — **7/7 pass** (new):
  - unordered tasks validate against `TaskDecompositionSchema` (model captured);
  - §11 abort throws the `task_decomposition` diagnostic (including a task
    carrying `dependsOn`, which fails the strict schema);
  - the stage is a real orchestration capability (`orchestration.tasks`);
  - `dedupeTasks` removes duplicate deliverables (first wins);
  - `enforceMaxTasks` caps an over-budget decomposition to `maxTasks`;
  - `completeTasks` produces full schema-valid `Task` objects with empty
    execution-free fields;
  - end-to-end: deduped, budgeted, completed tasks stored on a plan via
    `PlanStore` round-trip against `PlanSchema`.
- Full `packages/platform` vitest suite — **133/133 pass** (was 126, +7).
- Repo-wide `npm run check` **green**: biome, pinned-deps, ts-imports,
  shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke.
- `dist` not rebuilt: gitignored build output, no consumer yet (Step 1.4 precedent).

## 4. Scope Notes

- Step 2.7 was Task Decomposition + the deterministic dedupe/budget/completion
  passes. The Dependency Builder (2.8), which fills `dependsOn` and validates
  acyclicity, and the downstream stages are later steps and were not built.
- Full pipeline orchestration and the coding-agent entry point land at 2.12; this
  step supplies the stage + the deterministic passes, testable in isolation.
- No changelog entry: `packages/platform` has no `CHANGELOG.md` (created in
  Step 1.2; prior planning step reports added none).

## 5. Recommended Next Step

**Step 2.8 — Dependency Builder (DAG).** Per `docs/planning/PLANNING_STEPS.md`,
the Dependency Builder is the first deterministic orchestration core: it derives
edges from task inputs/outputs/deliverables then capabilities then explicit
ordering (with a bounded AI fallback on ambiguity), folds edges into `Task.dependsOn`,
and always validates acyclicity (topological sort) — feeding `circularDependencies`
to the Critic (2.9) rather than scheduling a cyclic graph. That makes the task set
a validated DAG ready for the Critic/Optimizer.
