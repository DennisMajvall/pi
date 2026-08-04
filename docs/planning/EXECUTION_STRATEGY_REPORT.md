# Planning (ROADMAP Step 2) — Execution Strategy Selection: Design Report (Step 2.5)

**Status:** Implemented and validated
**Based on:** `docs/planning/EXECUTION_STRATEGY_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

The first-class Execution Strategy Selection stage (§7) plus the deterministic
policy guard hook, in the `/planning` subpath. This is the single highest-
leverage decision in the pipeline: right after Goal Analysis it produces the
one `PlanningPolicy` that every downstream stage consumes, so depth / parallelism
/ approval / dual-planner decisions are made once instead of being re-derived
inconsistently per stage.

| Component | Location | What it is |
| --- | --- | --- |
| Execution Strategy stage | `packages/platform/src/planning/execution-strategy.ts` (new) | `executionStrategyStage(completion, routing?)` → `PlanningStage<typeof PlanningPolicySchema>` (`orchestration.strategy`) |
| Policy guard hook | `packages/platform/src/planning/policy.ts` (new) | `PolicyDowngrade` + `downgradePolicy` — deterministic, never-upgrades |
| Re-export | `packages/platform/src/planning/index.ts` | both added to `/planning` |
| Tests | `packages/platform/test/execution-strategy.test.ts` (new) | 8 tests |

Key behaviors:

- **Execution Strategy (`orchestration.strategy`)**: `systemPrompt` is the
  §6.3.2 exemplar ("decide how planning should behave, not what to do"); `run`
  resolves the model via `requireStageModel(EXECUTION_STRATEGY_MODEL_KEY, …)`,
  builds the prompt from `ExecutionStrategyInput = { goal, constraints? }`
  (§6.7: Goal Analysis output only), and calls `runStrictJsonStage` with
  `outputSchema: PlanningPolicySchema`, `mandatory: true`. A §11 abort throws
  the `execution_strategy` diagnostic; success returns the validated policy.
- **Stored on the plan**: the produced `PlanningPolicy` is assigned to
  `plan.policy` and persisted via `PlanStore.save` (validated by `PlanSchema`);
  it becomes part of every downstream stage's input set (§6.6). The pipeline
  orchestrator (2.12) threads it forward.
- **Deterministic guard hook (§7)**: `downgradePolicy(policy, downgrade)` is
  pure and never upgrades — it caps `planningDepth` downward, can only disable
  `parallelExecution`/`specialistAgents`/`dualPlanner`, and can only force
  `requireApproval`. Constraint Extraction (2.6) will use it to apply hard
  limits.

## 2. The Decisions This Step Made (from the design)

1. **`PlanningPolicy` enumerations already exist** on the 2.1 schema/type — no
   change this step; the stage emits against `PlanningPolicySchema`.
2. **Policy is stored on the plan and threaded into every downstream stage's
   input set** (§6.6) — made concrete by the store-compatible policy round-trip.
3. **The guard hook is deterministic and monotonic** (never upgrade), placed as a
   reusable `downgradePolicy` for 2.6 to wire hard constraints into.

## 3. Validation Results

- `packages/platform/test/execution-strategy.test.ts` — **8/8 pass** (new):
  - the stage returns a `PlanningPolicy` validating against
    `PlanningPolicySchema`, on the routed model;
  - §11 abort throws the `execution_strategy` diagnostic on persistent invalid
    output;
  - the stage is a real orchestration capability (`orchestration.strategy`);
  - the produced policy stores on a plan and round-trips against `PlanSchema` via
    `PlanStore` (load returns the stored policy);
  - `downgradePolicy` caps `planningDepth` downward (low stays low), disables
    parallelism/dual-planner and forces approval, never relaxes a field, and
    `requireStageModel` guards the model binding.
- Full `packages/platform` vitest suite — **118/118 pass** (was 110, +8).
- Repo-wide `npm run check` **green**: biome, pinned-deps, ts-imports,
  shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke.
- `dist` not rebuilt: gitignored build output, no consumer yet (Step 1.4 precedent).

## 4. Scope Notes

- Step 2.5 was the Execution Strategy stage + the policy guard hook. Constraint
  Extraction (2.6, which wires hard constraints into `downgradePolicy`) and the
  downstream stages are later steps and were not built.
- Full pipeline orchestration (threading Goal → Strategy → … → validated plan)
  and the coding-agent entry point land at 2.12; this step supplies the stage
  and the policy hook, testable in isolation.
- No changelog entry: `packages/platform` has no `CHANGELOG.md` (created in
  Step 1.2; prior planning step reports added none).

## 5. Recommended Next Step

**Step 2.6 — Constraint Extraction.** Per `docs/planning/PLANNING_STEPS.md`,
Constraint Extraction collects the four constraint families (hard/soft/
resource/policy) folding into `Plan.constraints`, and deterministically applies
the policy-downgrade rule via the 2.5 `downgradePolicy` hook — a hard
resource/time limit caps `planningDepth`, disables `parallelExecution`, or
forces `requireApproval`, but never upgrades. That wires the first real
constraint-driven guard onto the produced policy.
