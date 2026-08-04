# Planning (ROADMAP Step 2) — Goal Analysis + Clarification Gate: Design (Step 2.4)

**Status:** Design (pre-implementation)
**Based on:** `docs/PLANNING_ARCHITECTURE.md` §6.3.1 (Goal Analysis), §9 (Clarification), §6.2/§11 (stage contract + error containment); `docs/planning/PLANNING_STEPS.md` Step 2.4; `docs/planning/PLANNING_SKELETON_REPORT.md` (Step 2.3 recommended next step)
**Package:** `@earendil-works/pi-platform` (`/planning` subpath)
**Date:** 2026-02-08

---

## 1. Objective

Build the first **real AI stage** on the Step 2.3 pattern: `GoalAnalysis`
(§6.3.1) — an `orchestration` capability producing strict `Goal` JSON against
the Step 2.1 `GoalSchema`, routed to a purpose-chosen **cheap** model
(decoupled from the session's selected model) — plus the deterministic
**Clarification Gate** (§9) that pauses, surfaces questions, and loops back
within a bounded round count, proceeding with low-confidence assumptions when
the bound is exceeded.

## 2. Placement

Implementation, in the Step 2.3 `/planning` subpath:

| Artifact | Location |
| --- | --- |
| Goal Analysis stage (AI, cheap-model routed) | `packages/platform/src/planning/goal-analysis.ts` (new) |
| Deterministic Clarification Gate | `packages/platform/src/planning/clarification-gate.ts` (new) |
| Re-export | `packages/platform/src/planning/index.ts` |
| Tests | `packages/platform/test/goal-analysis.test.ts` (new) |

Reuses the 2.3 `runStrictJsonStage`, `resolveStageModel` / `StageModelRouting`,
`definePlanningStageCapability`, and the 2.1 `GoalSchema` / `Goal` /
`ClarificationQuestion` / `Assumption`. No contract module changes.

## 3. Goal Analysis (§6.3.1)

`goalAnalysisStage(completion, routing?)` returns `PlanningStage<typeof GoalSchema>`
with:

- `id: "orchestration.goal.analysis"`, `category: "orchestration"`,
  `outputSchema: GoalSchema`, `mandatory: true` (a failed Goal Analysis aborts —
  §11), `modelKey: "goal_analysis"`;
- `systemPrompt`: the §6.3.1 exemplar — "understand only, do not plan /
  decompose / estimate; return valid Goal JSON";
- `run(input, ctx)`: resolves the cheap model via
  `resolveStageModel("goal_analysis", routing ?? DEFAULT_STAGE_MODEL_ROUTING)`,
  builds the user prompt from `GoalAnalysisInput`
  (`{ userRequest, conversation?, availableCapabilities[]?, userPreferences[]? }`),
  and calls `runStrictJsonStage({ outputSchema: GoalSchema, mandatory: true,
  ... })`. A §11 abort (validation exhausted) throws with the stage-naming
  diagnostic. On success returns the validated `Goal`.

The `completion` is injected by the host (the coding-agent binds a real model
completion at 2.12 wiring; tests use a fake). The cheap-model routing is keyed
by stage id and independent of the session model — the same cheap model backs
the 2.12 complexity auto-trigger.

### 3.1 Model resolution source

The stage resolves its model from a `StageModelRouting` supplied by the host,
derived from a settings mapping: `stageModelRoutingFromSettings({ default,
stages })` turns a `StageModelSettings` (the `planning.models.*` shape) into the
routing the stage consumes, and `resolveStageModel(key, routing)` is the pure
lookup. Because the platform kernel does not own user settings (`ctx.settings` /
`ctx.configuration` are stubs), the user-facing settings value is read by the
coding-agent wiring (2.12) and passed in — the resolver itself stays a pure
lookup. If a stage is run with no routing configured, `requireStageModel`
throws loudly ("no model configured") instead of silently calling an empty
model id, so an unconfigured AI stage fails at startup, not mid-pipeline.

## 4. Clarification Gate (§9) — deterministic

One deterministic gate, not an AI stage. `runClarificationGate(goal, options)`
decides, with no model call:

| Decision | Condition |
| --- | --- |
| `clear` | goal has no `requiresClarification` and no blocking question |
| `needs_clarification` | requires clarification and `roundsUsed < maxRounds`: surface `goal.clarificationQuestions` (falling back to the unknowns) |
| `proceed_with_unknowns` | requires clarification but `roundsUsed >= maxRounds`: proceed, converting the goal's unknowns into low-confidence `Assumption`s (`source: "inferred"`, low confidence) so the plan exposes them (§13/§14) rather than stalling |

`ClarificationGateOptions = { maxRounds: number; roundsUsed: number }`, default
`maxRounds` 2. `roundsUsed` is the count of prior clarification round-trips, so
the loop is bounded and the caller re-runs **Goal Analysis only** (never the
whole pipeline, §9) with the user's answers on each pass.

The §9 questions live on the `Goal` (2.1 already placed
`requiresClarification` / `clarificationQuestions` there), so no schema change.

## 5. Public API

```ts
// goal-analysis.ts
interface GoalAnalysisInput { userRequest: string; conversation?: string; availableCapabilities?: string[]; userPreferences?: string[] }
const GOAL_ANALYSIS_SYSTEM_PROMPT: string;
goalAnalysisStage(completion: StageCompletion, routing?: StageModelRouting): PlanningStage<typeof GoalSchema>;

// clarification-gate.ts
interface ClarificationGateOptions { maxRounds?: number; roundsUsed: number }
type ClarificationGateResult =
  | { kind: "clear" }
  | { kind: "needs_clarification"; questions: ClarificationQuestion[] }
  | { kind: "proceed_with_unknowns"; assumptions: Assumption[] };
runClarificationGate(goal: Goal, options: ClarificationGateOptions): ClarificationGateResult;
```

## 6. Validation performed (this step)

- `packages/platform/test/goal-analysis.test.ts` (new):
  - Goal Analysis stage via a fake completion returns a schema-valid `Goal`
    (strict JSON, validated against `GoalSchema`);
  - cheap-model routing: the stage resolves `goal_analysis` → the configured
    cheap model id (independent of the session model);
  - §11 abort: a fake completion that never returns valid Goal JSON → the stage
    throws the stage-naming diagnostic;
  - Clarification Gate: `clear` when no clarification needed; `needs_clarification`
    surfaces questions within the bound; `proceed_with_unknowns` with
    low-confidence `Assumption`s when `roundsUsed >= maxRounds`;
  - end-to-end: run Goal Analysis on a request, feed a goal needing clarification
    through the gate, re-run Goal Analysis with answers, gate → `clear`.
- Full `packages/platform` vitest suite + repo-wide `npm run check` green.
