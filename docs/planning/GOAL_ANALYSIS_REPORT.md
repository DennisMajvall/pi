# Planning (ROADMAP Step 2) — Goal Analysis + Clarification Gate: Design Report (Step 2.4)

**Status:** Implemented and validated
**Based on:** `docs/planning/GOAL_ANALYSIS_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

The first real AI planning stage, built on the Step 2.3 container: `GoalAnalysis`
(§6.3.1) as an `orchestration` capability producing strict `Goal` JSON against
the Step 2.1 `GoalSchema`, routed to a purpose-chosen **cheap** model
(decoupled from the session's selected model) and executed through the §11
strict-JSON runner — plus the deterministic **Clarification Gate** (§9) that
pauses, surfaces questions, and loops back within a bounded round count.

| Component | Location | What it is |
| --- | --- | --- |
| Goal Analysis stage | `packages/platform/src/planning/goal-analysis.ts` (new) | `goalAnalysisStage(completion, routing?)` → `PlanningStage<typeof GoalSchema>`; cheap-model routed via `goal_analysis` key |
| Clarification Gate | `packages/platform/src/planning/clarification-gate.ts` (new) | `runClarificationGate(goal, opts)` — deterministic `clear` / `needs_clarification` / `proceed_with_unknowns` |
| Re-export | `packages/platform/src/planning/index.ts` | added both to the `/planning` subpath |
| Tests | `packages/platform/test/goal-analysis.test.ts` (new) | 8 tests |

Key behaviors:

- **Goal Analysis (`orchestration.goal.analysis`)**: `systemPrompt` is the §6.3.1
  exemplar ("understand only"); `run` resolves the cheap model via
  `resolveStageModel("goal_analysis", routing)`, builds the prompt from the
  structured `GoalAnalysisInput`, and calls `runStrictJsonStage` with
  `outputSchema: GoalSchema`, `mandatory: true`. A §11 abort (both attempts
  invalid) throws the stage-naming diagnostic. On success it returns the
  validated `Goal`.
- **Per-stage cheap routing**: `GoalAnalysisModelKey = "goal_analysis"` maps to a
  cheap model id in `StageModelRouting`, resolved at the stage contract level and
  independent of the session model — the same cheap model the 2.12 complexity
  auto-trigger uses.
- **Clarification Gate** is deterministic (no model call): `clear` when the goal
  needs no clarification; `needs_clarification` surfaces
  `goal.clarificationQuestions` (falling back to “why-unknown” questions) when
  `roundsUsed < maxRounds`; `proceed_with_unknowns` converts the goal's unknowns
  into low-confidence `Assumption`s (`source: "inferred"`, confidence 40) when
  `roundsUsed >= maxRounds`, so the plan exposes them instead of stalling.
- **Loop contract**: on `needs_clarification` the orchestrator re-runs **Goal
  Analysis only** (never the whole pipeline, §9) with the user's answers and
  increments `roundsUsed`; a resolved goal then passes the gate as `clear`.

## 2. The Decisions This Step Made (from the design)

1. **`requiresClarification` / `clarificationQuestions` live on the `Goal`** —
   already true from 2.1; no schema change this step.
2. **Goal Analysis runs on a purpose-chosen cheap model**, routed by the
   `goal_analysis` key via the 2.3 routing, independent of the session model.
3. **The gate is deterministic and bounded** (`maxRounds` default 2); exceeding
   the bound proceeds with low-confidence assumptions rather than stalling. It is
   a pure decision function a future orchestrator calls between Goal Analysis
   runs.
4. **The model `completion` is injected** (real binding is the 2.12 coding-agent
   wiring; tests/fakes now), consistent with 2.3 `runStrictJsonStage`.
5. **Model resolution is settings-shaped and guarded.** Routing is derived from a
   settings mapping via `stageModelRoutingFromSettings` (the `planning.models.*`
   shape) and passed in by the host; `resolveStageModel` is a pure lookup; and
   `requireStageModel` fails loudly rather than silently using an empty id when a
   stage is run without a configured model (the actual user-settings read is the
   2.12 wiring).

## 3. Validation Results

- `packages/platform/test/goal-analysis.test.ts` — **10/10 pass** (new):
  - Goal Analysis returns a `Goal` that validates against `GoalSchema`, and the
    model captured by the fake completion is the routed cheap model (`cheap-1`);
  - §11 abort: a completion that never returns valid Goal JSON → the run throws
    the `goal_analysis` diagnostic;
  - the stage is a real orchestration stage (wrappable via
    `definePlanningStageCapability`; manifest `orchestration.goal.analysis`);
  - an unconfigured Goal Analysis refuses to run (throws `no model configured`);
  - model resolution: `stageModelRoutingFromSettings` derives routing from a
    settings mapping, and `requireStageModel` rejects an empty (unconfigured)
    model loudly;
  - gate: `clear` when nothing to clarify; `needs_clarification` surfaces the
    blocking questions within the bound; `proceed_with_unknowns` exceeds the
    bound with the expected low-confidence assumptions; a re-run with answers
    resolves to `clear`;
  - the shared strict-JSON runner validates `Goal` output (retry-then-ok).
- Full `packages/platform` vitest suite — **110/110 pass** (was 99, +11).
- Repo-wide `npm run check` **green**: biome, pinned-deps, ts-imports,
  shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke.
- `dist` not rebuilt: gitignored build output, no consumer yet (Step 1.4 precedent).

## 4. Scope Notes

- Step 2.4 was Goal Analysis + the deterministic Clarification Gate. Execution
  Strategy Selection (2.5) and the downstream deterministic stages (2.6+) are
  later steps and were not built.
- The full pipeline orchestration (Goal Analysis → gate → re-run loop → next
  stage) and the coding-agent entry point land at 2.12; this step provides the
  stage and the deterministic gate decision, testable in isolation.
- No changelog entry: `packages/platform` has no `CHANGELOG.md` (created in
  Step 1.2; prior planning step reports added none).

## 5. Recommended Next Step

**Step 2.5 — Execution Strategy Selection (first-class).** The pipeline now has a
working first stage (Goal Analysis) and its gate; the highest-leverage next step
per `docs/planning/PLANNING_STEPS.md` is the first-class Execution Strategy
Selection that emits the `PlanningPolicy` (2.1) on a purpose-chosen cheap model
through the 2.3 runner/routing — keeping the "one policy, consumed by all"
invariant that every downstream stage's input set depends on.
