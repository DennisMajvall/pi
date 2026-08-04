# Planning (ROADMAP Step 2) — Task Decomposition: Design (Step 2.7)

**Status:** Design (pre-implementation)
**Based on:** `docs/PLANNING_ARCHITECTURE.md` §6.3.4 (stage 4), §6.6 (`maxTasks`), §11 (mandatory-stage containment); `docs/planning/PLANNING_STEPS.md` Step 2.7; `docs/planning/CONSTRAINT_EXTRACTION_REPORT.md` (Step 2.6 recommended next step)
**Package:** `@earendil-works/pi-platform` (`/planning` subpath)
**Date:** 2026-02-08

---

## 1. Objective

Break the goal into the smallest meaningful tasks as an AI stage that emits an
**unordered** task list — no ordering, no priorities, no dependencies, no
parallelism (§6.3.4) — plus a deterministic **dedupe pass** and **`maxTasks`
budget enforcement** from the `PlanningPolicy`. The partial tasks are then
completed onto the 2.1 `Plan.tasks` shape.

## 2. Placement

Implementation in the `/planning` subpath, reusing 2.3 `runStrictJsonStage` /
`requireStageModel` / `resolveStageModel`, 2.1 `Task` / `PlanningPolicy`, and the
identifier `taskId`:

| Artifact | Location |
| --- | --- |
| Task Decomposition stage (AI) | `packages/platform/src/planning/task-decomposition.ts` (new) |
| Deterministic dedupe/budget/complete helpers | `packages/platform/src/planning/tasks.ts` (new) |
| Re-export | `packages/platform/src/planning/index.ts` |
| Tests | `packages/platform/test/task-decomposition.test.ts` (new) |

No contract module changes.

## 3. Task Decomposition stage (§6.3.4)

`taskDecompositionStage(completion, routing?)` returns `PlanningStage<typeof
TaskDecompositionSchema>` with:

- `id: "orchestration.tasks"`, `category: "orchestration"`, `mandatory: true`,
  `modelKey: "task_decomposition"`;
- `TaskDecompositionSchema` = `{ tasks: Array<{ id, title, purpose, deliverable }> }`
  with `additionalProperties: false` on each task — so a stage output can never
  carry ordering/priority/dependency/parallelism fields (§5/§6.3.4 enforced
  structurally);
- `inputs: ["goal", "constraints", "policy", "capabilities", "skills"]` (§6.7);
  `TaskDecompositionInput = { goal; constraints?; policy; availableCapabilities?;
  skills? }`;
- `run` resolves the model, builds the prompt (including `maxTasks` from the
  policy), and runs `runStrictJsonStage({ outputSchema: TaskDecompositionSchema,
  mandatory: true, stageName: "task_decomposition" })`. A §11 abort throws the
  stage-naming diagnostic; success returns the unordered `DecomposedTask[]`.

## 4. Deterministic dedupe + budget + completion

Pure helpers in `planning/tasks.ts`:

```ts
dedupeTasks(tasks): DecomposedTask[];                 // dedupe by deliverable (first wins)
enforceMaxTasks(tasks, maxTasks): DecomposedTask[];   // dedupe, then cap to budget
completeTasks(tasks): Task[];                         // fill empty inputs/outputs/dependsOn/
                                                      // requiredCapabilities/verification (later stages fill)
```

- **Dedupe (§6.3.4 pass):** a task is a duplicate when its `deliverable` already
  appeared; the first occurrence wins (stable).
- **Budget (§6.6):** `enforceMaxTasks` dedupes then truncates deterministically to
  `policy.maxTasks`.
- **Completion:** each partial task becomes a full 2.1 `Task` (id wrapped in
  `taskId`, empty default fields) so it validates against `TaskSchema`/`PlanSchema`
  immediately; Dependency Builder (2.8) fills `dependsOn`, later stages fill the
  rest.

## 5. Public API

```ts
// task-decomposition.ts
const TASK_DECOMPOSITION_MODEL_KEY: string;
const TASK_DECOMPOSITION_SYSTEM_PROMPT: string;
const DecomposedTaskSchema: TSchema;
const TaskDecompositionSchema: TSchema;
interface TaskDecompositionInput { goal: Goal; constraints?: Constraint[]; policy: PlanningPolicy; availableCapabilities?: string[]; skills?: string[] }
taskDecompositionStage(completion, routing?): PlanningStage<typeof TaskDecompositionSchema>;

// tasks.ts
interface DecomposedTask { id: string; title: string; purpose: string; deliverable: string }
dedupeTasks(tasks: DecomposedTask[]): DecomposedTask[];
enforceMaxTasks(tasks: DecomposedTask[], maxTasks: number): DecomposedTask[];
completeTasks(tasks: DecomposedTask[]): Task[];
```

## 6. Validation performed (this step)

- `packages/platform/test/task-decomposition.test.ts` (new):
  - the stage returns unordered tasks validating against `TaskDecompositionSchema`
    (model captured from routing);
  - a §11 abort throws the `task_decomposition` diagnostic on persistent invalid
    output;
  - `dedupeTasks` removes a duplicate deliverable (first wins);
  - `enforceMaxTasks` caps an over-budget decomposition to `policy.maxTasks`;
  - `completeTasks` yields full `Task`s that validate against `TaskSchema` /
    `PlanSchema`, with empty execution-free fields; a task carrying a dependency
    field is rejected by the stage schema;
  - end-to-end: a plan with the completed, deduped, budgeted tasks stored via
    `PlanStore` round-trips.
- Full `packages/platform` vitest suite + repo-wide `npm run check` green.
