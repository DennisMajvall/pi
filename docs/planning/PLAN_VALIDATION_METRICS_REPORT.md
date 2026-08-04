# Planning (ROADMAP Step 2) — Plan Validation + Metrics: Design Report (Step 2.10)

**Status:** Implemented and validated
**Based on:** `docs/planning/PLAN_VALIDATION_METRICS_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

The deterministic validator plus the metrics that produce the validated, scored plan
the User Review gate (2.11) approves: **Plan Validation** (§6.3.8) and the **Planning
Metrics** split into DAG-derived `parallelism` (deterministic) and AI-assessed
subjectivity (§6.3.9 + §14), in the `/planning` subpath.

| Component | Location | What it is |
| --- | --- | --- |
| Acyclicity checker (exported) | `packages/platform/src/planning/dependency-builder.ts` (additive refactor) | the 2.8 private `findCycles` now `export function findCircularDependencies`, reused by both `buildDependencyGraph` and validation |
| Deterministic validator | `packages/platform/src/planning/validation.ts` (new) | `validatePlan` → `{ valid, issues }` over schema / cycle / coverage |
| DAG metrics + metrics stage | `packages/platform/src/planning/metrics.ts` (new) | `analyzeDag`, `computeParallelism`, optional non-mutating `metricsStage`, `combineMetrics` |
| Re-export | `packages/platform/src/planning/index.ts` | all added to `/planning` |
| Tests | `packages/platform/test/plan-validation-metrics.test.ts` (new) | 15 tests |

No contract-module changes — `MetricsSchema` already exists from Step 2.1.

Key behaviors:

- **`validatePlan(plan)`** deterministically reports issues (never throws, never
  mutates): a `schema` violation (the plan fails `PlanSchema` — a producing stage's
  bug), a `cycle` (acyclicity re-run on the persisted `dependsOn` DAG via the
  exported `findCircularDependencies`), an `unreachable_criterion` (a success
  criterion produced by no task's `deliverable`/`outputs`), a `task_purpose`
  (empty/blank task purpose), or a `duplicate_deliverable` (two tasks sharing a
  deliverable). `valid` is true iff `issues` is empty.
- **`analyzeDag(tasks)`** computes `taskCount`, `edgeCount`, `maxRank` (critical
  path), `maxRankWidth` (width proxy), and `dependencyDensity` with no LLM;
  **`computeParallelism(tasks)`** returns `round(maxRankWidth / (maxRank + 1) * 100)`
  clamped to 0–100 (width / critical path per §14).
- **`metricsStage`** (`orchestration.metrics`) is an **optional** (§11) AI stage that
  returns only the subjective fields (completeness/confidence/risk/unknownCount/
  missingInformation) against `AiAssessedMetricsSchema` — `parallelism` is absent by
  design so a model can never bid it. `combineMetrics(ai, parallelism)` merges the
  AI fields with the deterministic `parallelism` into the full §14 `Metrics`.

## 2. The Decisions This Step Made (from the design)

1. **Validation is purely deterministic and non-mutating**: it returns a typed
   `issues` list with per-class codes; the decision to retry/degrade comes from the
   producing stage's §11 path, not the validator.
2. **`parallelism` is the only DAG-derived metric on the plan** (§14); task count vs
   `maxTasks` and dependency density are computed (`analyzeDag`) but kept as
   diagnostics, not persisted.
3. **The AI metrics stage emits only subjective fields** — `parallelism` is never a
   field the model returns; `combineMetrics` injects the deterministic value.
4. **Metrics is an optional stage** (§11) — on repeated failure it returns
   `{ kind: "skipped" }` and never aborts; it is also non-mutating (never persists or
   edits the plan). Setting `plan.metrics` (no new revision — metrics change no tasks)
   is the 2.12 oracle's job.
5. **Acyclicity is shared, not duplicated**: the 2.8 `findCycles` was exported as
   `findCircularDependencies` and is the single acyclicity implementation used by both
   the Dependency Builder and 2.10 validation.

## 3. Validation Results

- `packages/platform/test/plan-validation-metrics.test.ts` — **15/15 pass** (new):
  - `validatePlan` passes a schema-valid, acyclic, fully-covered plan and flags the
    five issue classes (schema, cycle, unreachable criterion, empty task purpose,
    duplicate deliverable) independently;
  - `computeParallelism`: empty set → 0, a 3-task chain → 33, a 3-task fan-out →
    100; `analyzeDag` reports `{ taskCount: 3, maxRank: 1, maxRankWidth: 2 }` with
    the expected density;
  - `metricsStage` returns `AiAssessedMetrics` validating against `AiAssessedMetrics`
    schema on the routed model (`m-1`), skips (not aborts) on persistent invalid
    output (§11 optional), and is a real `orchestration.metrics` capability;
  - `combineMetrics` + `plan.metrics` validates against `PlanSchema` and round-trips
    via `PlanStore`, preserving the deterministic `parallelism`.
- Full `packages/platform` vitest suite — **164/164 pass** (was 149, +15).
- Repo-wide `npm run check` **green**: biome, pinned-deps, ts-imports, shrinkwrap,
  install-lock, `tsgo --noEmit`, browser-smoke.
- `dist` not rebuilt: gitignored build output, no consumer yet (Step 1.4 precedent).

## 4. Scope Notes

- Step 2.10 was the deterministic validator + metrics (DAG-derived `parallelism` and
  the optional non-mutating AI metrics stage). The User Review gate (2.11) and the
  end-to-end oracle that runs validation + sets `plan.metrics` (2.12) are later steps
  and were not built.
- Real model binding for the metrics stage is wiring done at 2.12; tests use a fake
  completion per the established approach.
- No changelog entry: `packages/platform` has no `CHANGELOG.md` (created in
  Step 1.2; prior planning step reports added none).

## 5. Recommended Next Step

**Step 2.11 — User Review / approval gate.** Per `docs/planning/PLANNING_STEPS.md`,
the status-transition gate (`needs_review → approved`), the schema-preserving
`user_edit` capability, and the dedicated TUI plan view. The validated, scored plan
this step produces is exactly what that review gate consumes: low completeness can
re-run the Critic, high risk can force approval, and many unknowns can route toward
clarification or explicit assumptions (§14) — all surfaced to the user for the
approval decision that the 2.12 scheduler then executes.
