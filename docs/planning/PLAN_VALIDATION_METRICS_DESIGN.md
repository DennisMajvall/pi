# Planning (ROADMAP Step 2) — Plan Validation + Metrics: Design (Step 2.10)

**Status:** Design (pre-implementation)
**Based on:** `docs/PLANNING_ARCHITECTURE.md` §6.3.8 (deterministic validation: schema,
acyclicity, coverage), §6.3.9 + §14 (`Metrics`: `parallelism` DAG-derived;
completeness/confidence/risk/unknowns AI-assessed, non-mutating);
`docs/planning/PLANNING_STEPS.md` Step 2.10; `docs/planning/CRITIC_OPTIMIZER_REPORT.md`
(Step 2.9 recommended next step)
**Package:** `@earendil-works/pi-platform` (`/planning` subpath)
**Date:** 2026-02-08

---

## 1. Objective

Close the plan-construction pipeline with two pieces that produce the validated,
scored plan the User Review gate (2.11) approves:

- **Deterministic Plan Validation** (§6.3.8): schema-validate the full plan, re-run
  the acyclicity check on the persisted DAG, and run the coverage check (every
  success criterion reachable from some task output; every task has a purpose; no
  duplicate deliverables). A validation failure is a **pipeline bug** — a stage
  output violated its contract — and is the signal the producing stage's
  retry/degrade path handles. The validator itself only *reports*; it never mutates
  the plan.
- **Planning Metrics** (§6.3.9 + §14): `parallelism` computed **deterministically**
  from the DAG (width / critical path, 0–100), and completeness/confidence/risk/
  unknown count AI-assessed with a small **non-mutating** prompt, then combined into
  the §14 `Metrics` object stored on the plan.

## 2. Placement

Implementation in the `/planning` subpath, reusing 2.8's acyclicity checker, the 2.1
`Plan`/`Task`/`PlanSchema`/`MetricsSchema`, and the 2.3 optional-stage runner:

| Artifact | Location |
| --- | --- |
| Acyclicity checker (make exported) | `packages/platform/src/planning/dependency-builder.ts` (additive refactor) |
| Deterministic validator | `packages/platform/src/planning/validation.ts` (new) |
| DAG metrics + metrics stage | `packages/platform/src/planning/metrics.ts` (new) |
| Re-export | `packages/platform/src/planning/index.ts` |
| Tests | `packages/platform/test/plan-validation-metrics.test.ts` (new) |

No contract module changes (`MetricsSchema` already exists in `schema/plan.ts`).

## 3. Deterministic validation (§6.3.8)

`validatePlan(plan: Plan): PlanValidationResult` where
`PlanValidationResult = { valid: boolean; issues: ValidationIssue[] }` and
`ValidationIssue = { code, message, path? }`. Codes:

- **`schema`** — the plan fails `PlanSchema` (a stored plan must always pass; a
  failure is a producing stage's bug).
- **`cycle`** — the DAG (edges derived from `plan.tasks[].dependsOn`) contains a
  cycle. Reuses `findCircularDependencies` (formerly the private `findCycles` in
  2.8, now exported).
- **`unreachable_criterion`** — a `successCriteria` entry is not produced by any
  task's `deliverable` or `outputs`.
- **`task_purpose`** — a task has an empty/blank `purpose`.
- **`duplicate_deliverable`** — two or more tasks share the same `deliverable`.

`valid` is true iff `issues` is empty. The module never mutates the plan; the oracle
(2.12 scheduler) decides the retry/degrade action from the issue list.

## 4. DAG-derived metrics (deterministic)

`analyzeDag(tasks): DagAnalysis` computes, without any LLM: `taskCount`, `edgeCount`
(sum of `dependsOn`), `maxRank` (critical path in edges), `maxRankWidth` (most tasks
sharing one topological rank — a width proxy), and `dependencyDensity`
(`edgeCount / taskCount`). Ranks come from the longest path to each task (rank 0 for
a no-dependency task), found by memoized DFS over `dependsOn`.

`computeParallelism(tasks): number` returns `round(maxRankWidth / (maxRank + 1) * 100)`
clamped to 0–100 (§14: parallelism is "width / critical path"). A wide, shallow DAG
scores high (a fully parallel fan-out → 100); a long, narrow chain scores low; an
empty task set → 0.

## 5. AI-assessed metrics + combine (§6.3.9, §14)

The AI stage emits **only the subjective fields** — `parallelism` is deliberately
absent, since it is computed deterministically and must never be hallucinated:

```ts
const AiAssessedMetricsSchema = Type.Object({
  completeness:    Type.Number({ minimum: 0, maximum: 100 }),
  confidence:      Type.Number({ minimum: 0, maximum: 100 }),
  risk:            Type.Union([low, medium, high]),
  unknownCount:    Type.Integer({ minimum: 0 }),
  missingInformation: Type.Array(Type.String()),
}, { additionalProperties: false });
```

`metricsStage(completion, routing?)` → `PlanningStage<typeof AiAssessedMetricsSchema>`:

- `id: "orchestration.metrics"`, category `orchestration`, **`mandatory: false`**
  (§11 — skipped, never aborts), `modelKey: "metrics"`;
- `inputs: ["plan"]`; `MetricsInput = { plan; analysis: DagAnalysis }` — the whole
  plan plus the deterministic DAG stats for context;
- `systemPrompt`: "score the plan objectively; do not modify it; return the
  subjective fields" (§6.3.9);
- `run` resolves the model and calls `runOptionalStage`, returning
  `OptionalStageResult<AiAssessedMetrics>`.

The stage never persists or edits the plan (non-mutating). `combineMetrics(ai,
parallelism): Metrics` merges the AI-assessed fields with the deterministic
`parallelism` into the §14 `Metrics`, and the oracle (2.12) stores it on
`plan.metrics` (no revision — metrics change no tasks).

## 6. Public API

```ts
// dependency-builder.ts (refactor: private findCycles → exported)
findCircularDependencies(tasks: Task[], edges: DependencyEdge[]): string[][];

// validation.ts
type ValidationIssueCode = "schema" | "cycle" | "unreachable_criterion" | "task_purpose" | "duplicate_deliverable";
interface ValidationIssue { code: ValidationIssueCode; message: string; path?: string }
interface PlanValidationResult { valid: boolean; issues: ValidationIssue[] }
validatePlan(plan: Plan): PlanValidationResult;

// metrics.ts
const METRICS_MODEL_KEY: string;
interface DagAnalysis { taskCount; edgeCount; maxRank; maxRankWidth; dependencyDensity }
analyzeDag(tasks: Task[]): DagAnalysis;
computeParallelism(tasks: Task[]): number;
const METRICS_SYSTEM_PROMPT: string;
const AiAssessedMetricsSchema: TSchema;
interface AiAssessedMetrics { completeness; confidence; risk: PlanRisk; unknownCount; missingInformation }
interface MetricsInput { plan: Plan; analysis: DagAnalysis }
metricsStage(completion, routing?): PlanningStage<typeof AiAssessedMetricsSchema>;
combineMetrics(ai: AiAssessedMetrics, parallelism: number): Metrics;
```

## 7. Validation performed (this step)

- `packages/platform/test/plan-validation-metrics.test.ts` (new):
  - `validatePlan` passes a schema-valid, acyclic, fully-covered plan; and
    reports `schema` / `cycle` / `unreachable_criterion` / `task_purpose` /
    `duplicate_deliverable` issues respectively;
  - `computeParallelism`: empty set → 0, long chain → low, fully parallel → 100;
    `analyzeDag` reports critical path and width;
  - the AI `metricsStage` returns `AiAssessedMetrics` validating against its schema
    (routed model captured, no parallelism field); **skips** (§11 optional) on
    persistent invalid output; is a real `orchestration.metrics` capability;
  - `combineMetrics` + setting `plan.metrics` validates against `PlanSchema` and
    round-trips via `PlanStore`, with deterministic parallelism preserved.
- Full `packages/platform` vitest suite + repo-wide `npm run check` green.
