# Planning (ROADMAP Step 2) — Plan Critic + Optimizer: Design (Step 2.9)

**Status:** Design (pre-implementation)
**Based on:** `docs/PLANNING_ARCHITECTURE.md` §6.3.6/7 (adversarial pass and refinement), §6.2/§11 (optional stages, skip on repeated failure), §8 (`critic`/`optimizer` revisions); `docs/planning/PLANNING_STEPS.md` Step 2.9; `docs/planning/DEPENDENCY_BUILDER_REPORT.md` (Step 2.8 recommended next step)
**Package:** `@earendil-works/pi-platform` (`/planning` subpath)
**Date:** 2026-02-08

---

## 1. Objective

Two adversarial/refinement AI stages that close the generate→critique→refine
loop on the built DAG: the **Plan Critic** (§6.3.6) tries to destroy the plan and
reports issues; the **Plan Optimizer** (§6.3.7) improves it within intent. Both
are **optional** stages (§11) — on repeated validation failure they are skipped,
never aborting the pipeline. Critic/Optimizer revisions are recorded on the plan
(§8).

## 2. Placement

Implementation in the `/planning` subpath, reusing 2.3 `runStrictJsonStage`
(+ a new `runOptionalStage` wrapper), the 2.1 `Plan`/`Task`/`PlanSchema`, and the
2.8 `DependencyEdge`:

| Artifact | Location |
| --- | --- |
| Optional-stage wrapper + `OptionalStageResult` | `packages/platform/src/planning/stage.ts` (additive) |
| Plan Critic stage | `packages/platform/src/planning/critic.ts` (new) |
| Plan Optimizer stage + revision helpers | `packages/platform/src/planning/optimizer.ts` (new) |
| Re-export | `packages/platform/src/planning/index.ts` |
| Tests | `packages/platform/test/critic-optimizer.test.ts` (new) |

No contract module changes.

## 3. Optional-stage wrapper (§11)

```ts
type OptionalStageResult<T> =
  | { kind: "ok"; output: T }
  | { kind: "skipped"; reason: string };

runOptionalStage<Out>(options): Promise<OptionalStageResult<Static<Out>>>
```

`runOptionalStage` calls `runStrictJsonStage` with `mandatory: false` and maps:
`ok` → `{ kind: "ok", output }`; `degraded` (second failure) → `{ kind: "skipped",
reason }`. Critic and Optimizer use this, so §11 "skip optional stages" is
explicit and testable (no abort path).

## 4. Plan Critic (§6.3.6)

`criticStage(completion, routing?)` returns `PlanningStage<typeof CriticSchema>`
with:

- `id: "orchestration.critic"`, `category: "orchestration"`, **`mandatory: false`**,
  `modelKey: "critic"`;
- `CriticSchema` — the strict adversarial output:
  `{ missingTasks[], duplicateTasks[], circularDependencies[][], incorrectAssumptions[],
  risks[], questions[] }` (`additionalProperties: false`);
- `inputs: ["goal", "constraints", "tasks", "edges", "policy"]` (§6.7);
  `CriticInput = { goal; constraints?; tasks; edges: DependencyEdge[]; policy }`;
- `systemPrompt`: "assume mistakes exist; find them; you are not helping create a
  plan; return valid Critique JSON";
- `run` resolves the model and calls `runOptionalStage({ outputSchema:
  CriticSchema, mandatory: false, stageName: "critic" })`, returning
  `OptionalStageResult<Critique>`.

The critique feeds the Optimizer (and its `circularDependencies` can echo the
builder's, §6.3.5).

## 5. Plan Optimizer (§6.3.7)

`optimizerStage(completion, routing?)` returns `PlanningStage<typeof PlanSchema>`
with:

- `id: "orchestration.optimizer"`, `category: "orchestration"`, **`mandatory: false`**,
  `modelKey: "optimizer"`;
- `outputSchema: PlanSchema` (oracle: an updated plan, same schema);
- `inputs: ["plan", "critique", "policy"]`; `OptimizerInput = { plan; critique?;
  policy }`;
- `systemPrompt`: "improve an already-good plan; never redesign the goal, never
  remove user intent; return valid Plan JSON";
- `run` calls `runOptionalStage({ outputSchema: PlanSchema, mandatory: false,
  stageName: "optimizer" })`, returning `OptionalStageResult<Plan>`.

### 5.1 Recording revisions (§8)

On an `ok` result, the orchestrator persists the optimizer's output and records a
`critic`/`optimizer` revision. Pure helpers in `optimizer.ts`:

```ts
changedTaskIds(before: Task[], after: Task[]): TaskId[];     // added + removed + modified
appendRevision(plan, reason: "critic" | "optimizer", changedTaskIds): Plan;  // next version + updatedAt
```

`changedTaskIds` diff is by task id then deep equality; `appendRevision` appends
`{ version: last+1, reason, changedTaskIds, createdAt: now }` and bumps
`updatedAt`. The whole document is then re-stored via the 2.2 `PlanStore` §8
full-document rule, preserving goal/intent (the optimizer never removed it).

## 6. Public API

```ts
// stage.ts (additive)
type OptionalStageResult<T> = { kind: "ok"; output: T } | { kind: "skipped"; reason: string };
runOptionalStage<Out>(options: StrictJsonOptions<Out>): Promise<OptionalStageResult<Static<Out>>>;

// critic.ts
const CRITIC_MODEL_KEY: string;
const CriticSchema: TSchema;
interface Critique { missingTasks: string[]; duplicateTasks: string[]; circularDependencies: string[][]; incorrectAssumptions: string[]; risks: string[]; questions: string[] }
interface CriticInput { goal: Goal; constraints?: Constraint[]; tasks: Task[]; edges: DependencyEdge[]; policy: PlanningPolicy }
criticStage(completion, routing?): PlanningStage<typeof CriticSchema>;

// optimizer.ts
const OPTIMIZER_MODEL_KEY: string;
interface OptimizerInput { plan: Plan; critique?: Critique; policy: PlanningPolicy }
optimizerStage(completion, routing?): PlanningStage<typeof PlanSchema>;
changedTaskIds(before: Task[], after: Task[]): TaskId[];
appendRevision(plan: Plan, reason: "critic" | "optimizer", changedTaskIds: TaskId[]): Plan;
```

## 7. Validation performed (this step)

- `packages/platform/test/critic-optimizer.test.ts` (new):
  - the Critic returns a `Critique` validating against `CriticSchema`
    (model captured), and an `OptionalStageResult` with `kind: "ok"`;
  - the Critic **skips** (§11 optional) rather than aborts on a persistently
    invalid completion;
  - the Optimizer returns an updated `Plan` validating against `PlanSchema`
    (model captured); it skips on persistent invalid output;
  - `changedTaskIds` reports added/removed/modified task ids;
  - `appendRevision` records a `critic`/`optimizer` revision with the next version
    and bumped `updatedAt`; the revised plan with the optimizer's tasks
    round-trips via `PlanStore` (goal/intent preserved);
  - end-to-end: critique → optimizer → persist with an `optimizer` revision.
- Full `packages/platform` vitest suite + repo-wide `npm run check` green.
