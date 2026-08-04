# Planning (ROADMAP Step 2) — Execution Strategy Selection: Design (Step 2.5)

**Status:** Design (pre-implementation)
**Based on:** `docs/PLANNING_ARCHITECTURE.md` §7 (why first-class), §6.3.2 (the stage), §6.6 (policy drives everything); `docs/planning/PLANNING_STEPS.md` Step 2.5; `docs/planning/GOAL_ANALYSIS_REPORT.md` (Step 2.4 recommended next step)
**Package:** `@earendil-works/pi-platform` (`/planning` subpath)
**Date:** 2026-02-08

---

## 1. Objective

The single highest-leverage stage in the pipeline (§7): an AI **Execution
Strategy Selection** that, right after Goal Analysis, decides *how planning
itself should behave* for the request and emits the `PlanningPolicy` (2.1) —
one policy object consumed by every downstream stage, so depth, parallelism,
approval, and dual-planner decisions are made once instead of being re-derived
inconsistently by each stage. Includes the deterministic "policy drives
behavior" guard hook (§7): constraints may *downgrade* policy fields but never
upgrade them.

## 2. Placement

Implementation in the Step 2.3/2.4 `/planning` subpath:

| Artifact | Location |
| --- | --- |
| Execution Strategy stage (AI) | `packages/platform/src/planning/execution-strategy.ts` (new) |
| Deterministic policy guard hook | `packages/platform/src/planning/policy.ts` (new) |
| Re-export | `packages/platform/src/planning/index.ts` |
| Tests | `packages/platform/test/execution-strategy.test.ts` (new) |

Reuses 2.3 `runStrictJsonStage` / `requireStageModel` / `resolveStageModel` /
`StageModelRouting` and the 2.1 `PlanningPolicySchema` / `PlanningPolicy` /
`PlanningDepth`. No contract module changes.

## 3. Execution Strategy stage (§6.3.2)

`executionStrategyStage(completion, routing?)` returns `PlanningStage<typeof
PlanningPolicySchema>` with:

- `id: "orchestration.strategy"`, `category: "orchestration"`,
  `outputSchema: PlanningPolicySchema`, `mandatory: true`, `modelKey:
  "execution_strategy"`;
- `systemPrompt`: "decide how planning should behave — depth, parallelism,
  approval, dual planner — not how to complete the work; return valid
  PlanningPolicy JSON";
- `inputs: ["goal", "constraints"]` (§6.7: consumes Goal Analysis output only);
- `run(input, ctx)`: resolves the model via
  `requireStageModel(EXECUTION_STRATEGY_MODEL_KEY, …)`, builds the prompt from
  `ExecutionStrategyInput = { goal: Goal; constraints?: Constraint[] }`, and
  calls `runStrictJsonStage({ outputSchema: PlanningPolicySchema, mandatory:
  true, stageName: "execution_strategy" })`. A §11 abort throws the stage-naming
  diagnostic; success returns the validated `PlanningPolicy`.

The produced `PlanningPolicy` is stored on the plan (`plan.policy`) and is part
of every downstream stage's input set (§6.6). Storage is a plain
schema-preserving assignment (`plan.policy = policy`) validated by
`PlanStore.save`; the pipeline orchestrator (2.12) threads it forward.

## 4. The "policy drives behavior" guard hook (§7)

`downgradePolicy(policy, downgrade)` is a deterministic, pure function that
applies a `PolicyDowngrade` to a policy and **never upgrades** it — the rule a
hard resource/time constraint will use in 2.6:

```ts
interface PolicyDowngrade {
  planningDepth?: PlanningDepth;      // caps depth downward (e.g. to "medium")
  parallelExecution?: false;          // can only disable
  specialistAgents?: false;           // can only disable
  dualPlanner?: false;                // can only disable
  requireApproval?: true;             // can only force
}
```

- `planningDepth` is capped: the result is the *less deep* of the current and
  downgraded values (low < medium < high). A downgrade can only move depth
  down.
- The boolean flags are one-directional: `parallelExecution`/`specialistAgents`/
  `dualPlanner` can only be set to `false`; `requireApproval` can only be set to
  `true`. A downgrade never relaxes a policy field.

## 5. Public API

```ts
// execution-strategy.ts
const EXECUTION_STRATEGY_MODEL_KEY: string;
const EXECUTION_STRATEGY_SYSTEM_PROMPT: string;
interface ExecutionStrategyInput { goal: Goal; constraints?: Constraint[] }
executionStrategyStage(completion, routing?): PlanningStage<typeof PlanningPolicySchema>;

// policy.ts
interface PolicyDowngrade { planningDepth?; parallelExecution?: false; specialistAgents?: false; dualPlanner?: false; requireApproval?: true }
downgradePolicy(policy: PlanningPolicy, downgrade: PolicyDowngrade): PlanningPolicy;
```

## 6. Validation performed (this step)

- `packages/platform/test/execution-strategy.test.ts` (new):
  - the stage returns a `PlanningPolicy` that validates against
    `PlanningPolicySchema` (model captured from the injected routing);
  - a §11 abort throws the `execution_strategy` diagnostic on persistent invalid
    output;
  - the produced policy is store-compatible: assigning it to a plan's `policy`
    and saving via `PlanStore.save` round-trips cleanly against `PlanSchema`;
  - `downgradePolicy` never upgrades: a hard downgrade caps `planningDepth`
    downward, disables `parallelExecution`, forces `requireApproval`, and leaves
    already-stricter settings unchanged; an "upgrade" in the downgrade is
    ignored.
- Full `packages/platform` vitest suite + repo-wide `npm run check` green.
