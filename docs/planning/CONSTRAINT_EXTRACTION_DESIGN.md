# Planning (ROADMAP Step 2) — Constraint Extraction: Design (Step 2.6)

**Status:** Design (pre-implementation)
**Based on:** `docs/PLANNING_ARCHITECTURE.md` §6.3.3 (stage 3), §7 (deterministic downgrade rule); `docs/planning/PLANNING_STEPS.md` Step 2.6; `docs/planning/EXECUTION_STRATEGY_REPORT.md` (Step 2.5 recommended next step)
**Package:** `@earendil-works/pi-platform` (`/planning` subpath)
**Date:** 2026-02-08

---

## 1. Objective

Collect every limitation that should influence planning into `Plan.constraints`
and deterministically apply the policy-downgrade rule (§7): hard
resource/time constraints may *downgrade* the stored `PlanningPolicy` (via the
Step 2.5 `downgradePolicy`) but never upgrade it.

## 2. Placement

Implementation in the `/planning` subpath, reusing 2.1 `Constraint` /
`PlanningPolicy`, 2.5 `downgradePolicy` / `PolicyDowngrade`, and 2.3
`runStrictJsonStage` / `requireStageModel` / `resolveStageModel`:

| Artifact | Location |
| --- | --- |
| Constraint Extraction stage (AI) | `packages/platform/src/planning/constraint-extraction.ts` (new) |
| Deterministic fold + downgrade rule | `packages/platform/src/planning/constraints.ts` (new) |
| Re-export | `packages/platform/src/planning/index.ts` |
| Tests | `packages/platform/test/constraint-extraction.test.ts` (new) |

No contract module changes.

## 3. Constraint Extraction stage (§6.3.3)

`constraintExtractionStage(completion, routing?)` returns `PlanningStage<typeof
ConstraintExtractionSchema>` with:

- `id: "orchestration.constraints"`, `category: "orchestration"`,
  `mandatory: true`, `modelKey: "constraint_extraction"`;
- `ConstraintExtractionSchema` — the strict four-family output:
  `{ hardConstraints, softConstraints, resourceConstraints, policyConstraints }`
  each `string[]`;
- `inputs: ["goal", "runtime"]` (§6.7); `ConstraintExtractionInput = { goal:
  Goal; runtime?: RuntimeConstraintContext }` where the runtime context carries
  OS / installed software / available tools / model limits / time limit /
  permissions;
- `run` resolves the model via `requireStageModel(CONSTRAINT_EXTRACTION_MODEL_KEY,
  …)`, builds the prompt, and runs `runStrictJsonStage({ outputSchema:
  ConstraintExtractionSchema, mandatory: true, stageName: "constraint_extraction" })`.
  A §11 abort throws the stage-naming diagnostic; success returns the four
  families.

## 4. Deterministic fold + downgrade rule (§6.3.3/§7)

Two pure functions in `planning/constraints.ts`:

```ts
// Fold the four AI families into Plan.constraints (kind: hard|soft|resource|policy).
foldConstraints(families): Constraint[];

// Derive a PolicyDowngrade from the constraints, deterministically.
policyDowngradeFromConstraints(constraints): PolicyDowngrade;

// Convenience: apply downgradePolicy(policy, downgradeFromConstraints(...)).
applyConstraintDowngrade(policy, constraints): PlanningPolicy;
```

`policyDowngradeFromConstraints` looks only at `hard` / `resource` constraints and
applies keyword signals (documented, deterministic):
- time/deadline signal ⇒ `planningDepth` capped to `"medium"`;
- parallelism-limit signal ⇒ `parallelExecution: false`;
- approval signal (hard only) ⇒ `requireApproval: true`;
- budget/resource signal ⇒ `specialistAgents: false`, `dualPlanner: false`.

Because it feeds `downgradePolicy` (2.5), the result **never upgrades** a field —
hard limits cap policy, never relax it (§7). `applyConstraintDowngrade` returns the
downgraded `PlanningPolicy` ready to be stored on the plan and re-saved via the 2.2
`PlanStore`.

## 5. Public API

```ts
// constraint-extraction.ts
const CONSTRAINT_EXTRACTION_MODEL_KEY: string;
const CONSTRAINT_EXTRACTION_SYSTEM_PROMPT: string;
const ConstraintExtractionSchema: TSchema;
interface RuntimeConstraintContext { os?; installedSoftware?; availableTools?; modelLimits?; timeLimit?; permissions? }
interface ConstraintExtractionInput { goal: Goal; runtime?: RuntimeConstraintContext }
constraintExtractionStage(completion, routing?): PlanningStage<typeof ConstraintExtractionSchema>;

// constraints.ts
interface ConstraintFamilies { hardConstraints: string[]; softConstraints: string[]; resourceConstraints: string[]; policyConstraints: string[] }
foldConstraints(families: ConstraintFamilies): Constraint[];
policyDowngradeFromConstraints(constraints: Constraint[]): PolicyDowngrade;
applyConstraintDowngrade(policy: PlanningPolicy, constraints: Constraint[]): PlanningPolicy;
```

## 6. Validation performed (this step)

- `packages/platform/test/constraint-extraction.test.ts` (new):
  - the stage returns the four families validating against
    `ConstraintExtractionSchema` (model captured from routing);
  - a §11 abort throws the `constraint_extraction` diagnostic on persistent
    invalid output;
  - `foldConstraints` maps the four families onto `Plan.constraints` with the
    right `kind`;
  - `policyDowngradeFromConstraints` + `applyConstraintDowngrade` cap a hard time
    limit to `planningDepth: "medium"`, disable parallelism on a resource limit,
    force approval on a hard approval constraint, and never upgrade (an already-low
    depth / already-disabled flag is left alone);
  - end-to-end: a plan with constraints folded and the downgrade stored round-trips
    against `PlanSchema` via `PlanStore`.
- Full `packages/platform` vitest suite + repo-wide `npm run check` green.
