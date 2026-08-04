# Planning (ROADMAP Step 2) — Constraint Extraction: Design Report (Step 2.6)

**Status:** Implemented and validated
**Based on:** `docs/planning/CONSTRAINT_EXTRACTION_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

Constraint Extraction (§6.3.3) — the AI stage that collects every limitation
into the four constraint families, folded deterministically onto
`Plan.constraints` — plus the deterministic policy-downgrade rule built on the
Step 2.5 `downgradePolicy` guard hook, in the `/planning` subpath.

| Component | Location | What it is |
| --- | --- | --- |
| Constraint Extraction stage | `packages/platform/src/planning/constraint-extraction.ts` (new) | `constraintExtractionStage(completion, routing?)` → `PlanningStage<typeof ConstraintExtractionSchema>` (`orchestration.constraints`) |
| Fold + downgrade rule | `packages/platform/src/planning/constraints.ts` (new) | `foldConstraints`, `policyDowngradeFromConstraints`, `applyConstraintDowngrade` |
| Re-export | `packages/platform/src/planning/index.ts` | all added to `/planning` |
| Tests | `packages/platform/test/constraint-extraction.test.ts` (new) | 8 tests |

Key behaviors:

- **Constraint Extraction (`orchestration.constraints`)**: `systemPrompt` is the
  §6.3.3 exemplar; `run` resolves the model via
  `requireStageModel(CONSTRAINT_EXTRACTION_MODEL_KEY, …)`, builds the prompt from
  `ConstraintExtractionInput = { goal, runtime? }` (runtime carries OS / installed
  software / tools / model limits / time limit / permissions, §6.7), and calls
  `runStrictJsonStage` with `outputSchema: ConstraintExtractionSchema`,
  `mandatory: true`. A §11 abort throws the `constraint_extraction` diagnostic;
  success returns the four families (`hard`/`soft`/`resource`/`policy`).
- **`foldConstraints`** maps the four families onto the stored
  `Plan.constraints` form (`Array<{ kind, description }>`).
- **Deterministic downgrade rule (§7)**: `policyDowngradeFromConstraints` looks
  only at `hard`/`resource` constraints and, on documented keyword signals, caps
  `planningDepth` to `medium` (time/deadline), disables `parallelExecution`
  (parallelism/serial), forces `requireApproval` (hard review/approval), and drops
  `specialistAgents` + `dualPlanner` (budget/resource). Because it feeds
  `downgradePolicy`, it **never upgrades** — the §7 invariant. `applyConstraintDowngrade`
  is the single call the pipeline uses to downgrade the stored policy.

## 2. The Decisions This Step Made (from the design)

1. **Runtime context feeds in** as a structured `RuntimeConstraintContext` in the
   stage input (never the whole conversation, §6.7).
2. **The four families fold onto `Plan.constraints`** via `foldConstraints`
   (kind: hard/soft/resource/policy).
3. **The downgrade merge rule is deterministic + monotonic** — keyword signals on
   hard/resource constraints only, applied through the 2.5 `downgradePolicy`
   (never upgrade). Soft/policy constraints never downgrade.

## 3. Validation Results

- `packages/platform/test/constraint-extraction.test.ts` — **8/8 pass** (new):
  - the stage returns the four families validating against
    `ConstraintExtractionSchema`, on the routed model;
  - §11 abort throws the `constraint_extraction` diagnostic;
  - the stage is a real orchestration capability (`orchestration.constraints`);
  - `foldConstraints` maps the four families onto `Plan.constraints` with the
    right kinds;
  - the downgrade caps a hard time limit to `planningDepth: "medium"`, disables
    specialists/dual-planner on no-budget, forces approval on a hard review
    constraint, and disables parallelism on a "one at a time" constraint;
  - never-upgrades: soft/policy constraints and already-stricter settings are
    left unchanged;
  - end-to-end: folded constraints + downgraded policy stored on a plan via
    `PlanStore` round-trips cleanly against `PlanSchema`.
- Full `packages/platform` vitest suite — **126/126 pass** (was 118, +8).
- Repo-wide `npm run check` **green**: biome, pinned-deps, ts-imports,
  shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke.
- `dist` not rebuilt: gitignored build output, no consumer yet (Step 1.4 precedent).

## 4. Scope Notes

- Step 2.6 was Constraint Extraction + the deterministic fold/downgrade. Task
  Decomposition (2.7) and the downstream stages are later steps and were not built.
- Full pipeline orchestration (threading goal → strategy → constraints → …) and
  the coding-agent entry point land at 2.12; this step supplies the stage and the
  deterministic rule, testable in isolation.
- No changelog entry: `packages/platform` has no `CHANGELOG.md` (created in
  Step 1.2; prior planning step reports added none).

## 5. Recommended Next Step

**Step 2.7 — Task Decomposition.** Per `docs/planning/PLANNING_STEPS.md`, Task
Decomposition breaks the goal into the smallest meaningful tasks (unordered, no
ordering/deps/priorities), with a deterministic dedupe pass, `maxTasks` budget
enforcement from the (possibly downgraded) `PlanningPolicy`, and §11
mandatory-stage containment. Its output feeds the Deterministic Dependency
Builder (2.8).
