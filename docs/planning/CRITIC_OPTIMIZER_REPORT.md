# Planning (ROADMAP Step 2) — Plan Critic + Optimizer: Design Report (Step 2.9)

**Status:** Implemented and validated
**Based on:** `docs/planning/CRITIC_OPTIMIZER_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

The adversarial/refinement pair that closes the generate→critique→refine loop on
the built DAG, in the `/planning` subpath: the **Plan Critic** (§6.3.6) and the
**Plan Optimizer** (§6.3.7), both **optional** stages (§11 — skipped, never
aborting), plus the §8 revision helpers.

| Component | Location | What it is |
| --- | --- | --- |
| Optional-stage wrapper | `packages/platform/src/planning/stage.ts` (additive) | `OptionalStageResult<T>` + `runOptionalStage` (maps §11 `degraded` → `{ kind: "skipped" }`) |
| Plan Critic stage | `packages/platform/src/planning/critic.ts` (new) | `criticStage(completion, routing?)` → `PlanningStage<typeof CriticSchema>` (`orchestration.critic`) |
| Plan Optimizer + revisions | `packages/platform/src/planning/optimizer.ts` (new) | `optimizerStage(completion, routing?)` → `PlanningStage<typeof PlanSchema>` (`orchestration.optimizer`); `changedTaskIds`, `appendRevision` |
| Re-export | `packages/platform/src/planning/index.ts` | all added to `/planning` |
| Tests | `packages/platform/test/critic-optimizer.test.ts` (new) | 8 tests |

Key behaviors:

- **`runOptionalStage`** wraps `runStrictJsonStage` with `mandatory: false` and
  returns `{ kind: "ok", output }` or `{ kind: "skipped", reason }` — the §11
  "optional stages skip" rule made explicit and testable.
- **Plan Critic (`orchestration.critic`)**: `CriticSchema` = `{ missingTasks,
  duplicateTasks, circularDependencies[][], incorrectAssumptions, risks,
  questions }` (strict); input = goal, constraints, tasks, edges, policy (§6.7);
  adversarial system prompt (§6.3.6); optional. The critique feeds the Optimizer.
- **Plan Optimizer (`orchestration.optimizer`)**: `outputSchema: PlanSchema`
  (an updated plan, same schema); input = draft plan + critique + policy;
  within-intent system prompt (§6.3.7); optional. Returns the improved plan.
- **§8 revisions**: `changedTaskIds(before, after)` diffs by id then `Equal`
  (added + removed + modified); `appendRevision(plan, reason, ids)` appends a
  `critic`/`optimizer` revision with the next version + refreshed `updatedAt`.
  The whole document is re-stored via `PlanStore` (§8 full-document rule),
  preserving the goal (the optimizer never removed intent).

## 2. The Decisions This Step Made (from the design)

1. **The critique schema** is the §6.3.6 six-field shape, strict
   (`additionalProperties: false`).
2. **Critic/Optimizer are optional** (§11) — `runOptionalStage` yields an explicit
   `skipped` result; the pipeline never aborts on their failure.
3. **Revision recording is deterministic and schema-preserving**: a pure
   `changedTaskIds` diff + `appendRevision`, persisted as a full-document re-store
   via `PlanStore` with goal/intent preserved.
4. Dual-planner merged-plan handling is deferred (policy-gated `dualPlanner`
   extension, not its own step).

## 3. Validation Results

- `packages/platform/test/critic-optimizer.test.ts` — **8/8 pass** (new):
  - Critic returns a `Critique` validating against `CriticSchema` on the routed
    model;
  - Critic **skips** (not aborts) on persistent invalid output (§11 optional);
  - Critic is a real orchestration capability (`orchestration.critic`);
  - Optimizer returns an updated plan validating against `PlanSchema` on the
    routed model; skips on persistent invalid output;
  - `changedTaskIds` reports added/removed/modified task ids;
  - `appendRevision` records `optimizer`/`critic` revisions with incremented
    versions;
  - end-to-end: optimizer result + `optimizer` revision persisted via `PlanStore`
    (goal preserved, `PlanSchema` valid).
- Full `packages/platform` vitest suite — **149/149 pass** (was 141, +8).
- Repo-wide `npm run check` **green**: biome, pinned-deps, ts-imports,
  shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke.
- `dist` not rebuilt: gitignored build output, no consumer yet (Step 1.4 precedent).

## 4. Scope Notes

- Step 2.9 was the Critic + Optimizer pair (both optional) and the §8 revision
  helpers. Plan Validation + Metrics (2.10), which consumes the refined plan, and
  the downstream steps are later steps and were not built.
- Dual-planner merged-plan handling is deferred (it is a policy-gated extension),
  documented in PLANNING_STEPS §10.
- Full pipeline orchestration and the coding-agent entry point land at 2.12.
- No changelog entry: `packages/platform` has no `CHANGELOG.md` (created in
  Step 1.2; prior planning step reports added none).

## 5. Recommended Next Step

**Step 2.10 — Plan Validation + Metrics.** Per `docs/planning/PLANNING_STEPS.md`,
the deterministic validator (schema-validate the full plan, re-run the acyclicity
check, coverage check — every success criterion reachable from some task output,
every task has a purpose, no duplicate deliverables) plus the `Metrics` set on the
plan (§14): `parallelism` computed from the DAG (width / critical path) and
completeness/confidence/risk/unknowns AI-assessed with a small non-mutating
prompt. That produces the validated, scored plan the User Review gate (2.11)
approves.
