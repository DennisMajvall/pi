# Planning (ROADMAP Step 2) — User Review / approval gate: Design Report (Step 2.11)

**Status:** Implemented and validated
**Based on:** `docs/planning/PLAN_USER_REVIEW_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

The deterministic human gate that turns the validated, scored plan (2.10) into the
**approved** plan the 2.12 scheduler executes: the `needs_review → approved`
transition honoring `policy.requireApproval`, the schema-preserving `user_edit`
engine, and the deterministic plan view (text render) the TUI plan view displays. In
the `/planning` subpath.

| Component | Location | What it is |
| --- | --- | --- |
| Approval gate | `packages/platform/src/planning/user-review.ts` (new) | `evaluateReviewGate`, `requestReview`, `approvePlan`, `autoApprovePlan` + the `orchestration.plan.review` capability |
| Schema-preserving edit engine | `packages/platform/src/planning/user-edit.ts` (new) | `PlanEdit` ops, `applyPlanEdit`/`applyPlanEdits`, `parsePlanEdit`, `orchestration.plan.edit` capability |
| Deterministic plan view | `packages/platform/src/planning/plan-view.ts` (new) | `renderPlanView`/`renderPlanHead`/`renderTaskList`/`renderPlanDag`/`renderRevisionHistory` |
| Re-export | `packages/platform/src/planning/index.ts` | all added to `/planning` |
| Tests | `packages/platform/test/plan-review.test.ts` (new) | 30 tests |

No contract-module changes — `RevisionReason.approval`/`user_edit`, the status enum,
and `PlanSchema`/`PlanningPolicySchema`/`MetricsSchema` all exist from Step 2.1.

Key behaviors:

- **Gate (pure, deterministic).** `evaluateReviewGate` → `required` iff
  `policy.requireApproval` (the default `true` for `planningDepth ≥ medium`, set by
  Execution Strategy); otherwise `auto_approved`. `requestReview` moves `draft →
  needs_review` without a revision; `approvePlan` flips `needs_review → approved`
  and records an `approval` revision (§8); `autoApprovePlan` goes straight to
  `approved` for a waived policy. The `orchestration.plan.review` capability loads,
  transitions (honoring the gate), saves, and emits `plan.approved` — and refuses to
  force-approve a still-`draft` plan under a required gate (it lands in
  `needs_review` instead).
- **Schema-preserving `user_edit`.** Eight ops (`rename`, `repurpose`,
  `add_dependency`, `remove_dependency`, `merge`, `split`, `add_constraint`,
  `set_policy`) each bump a `user_edit` revision with the changed task ids. Every
  edit re-checks acyclicity (2.8 `findCircularDependencies`), `dependsOn`-references-
  existing-ids, and `PlanSchema` — an edit that would introduce a cycle is rejected,
  and the persisted plan is always schema-valid and a DAG. `repurpose` rewires
  downstream `inputs` that referenced the old deliverable; `merge` rewires dependents
  to the merged id and prunes merged ids from deps; `split` derives part ids
  (`t1-1`, `t1-2`) and makes dependents wait on all parts. `parsePlanEdit` translates
  the architecture's one-liners ("merge tasks 3 and 4 [into X]", "move A after B",
  "run A in parallel with B", "split A into B, C", "rename A to B", "add constraint",
  "set <field> to <value>"), resolving refs by id, `t<N>`, or title.
- **Deterministic plan view.** `renderPlanView` emits head (id, status, version,
  gate, metrics), constraints, assumptions, tasks (with deps), the DAG as an indented
  outline using 2.10 `analyzeDag` diagnostics, and the revision history. Pure and
  idempotent — the shared view source for on-disk review and the TUI plan view.

## 2. The Decisions This Step Made (from the design)

1. **Approval is a deterministic status transition, never an AI decision.** The gate
   honors `policy.requireApproval` (default true for medium+ set by the strategy
   stage); both `approvePlan` and `autoApprovePlan` record an `approval` revision
   (§8) with no task changes.
2. **`requestReview` is a distinct transition from approval**: `draft → needs_review`
   records no revision (review changes no tasks); only approval records an
   `approval` revision.
3. **`user_edit` is deterministic and schema-preserving.** The typed `PlanEdit`
   union is the primary surface (what the TUI/agent sends); `parsePlanEdit` is a
   best-effort translator with a small, tested directive grammar. Every edit ends in
   an acyclicity + schema guard, so an edit that would break the DAG or the contract
   is rejected with a diagnostic rather than persisted.
4. **The TUI plan-view surface is a 2.12 wiring decision.** This step ships the
   deterministic platform core (gate + editable plan + textual DAG/task renderer),
   which is what the TUI displays and what 2.12's agent-loop integration consumes.
   Steps 2.1–2.10 stayed purely in `packages/platform`; the interactive TUI widget
   (pane/command binding + prompt collection) is scoped to 2.12 with the orchestrator
   and real model wiring. This is the consistent reading of §15's open question
   ("inline editor vs selector; DAG rendering") against PLANNING_STEPS Step 2.12.

## 3. Validation Results

- `packages/platform/test/plan-review.test.ts` — **30/30 pass** (new):
  - gate decision (required for the medium+ default, auto_approved when waived);
  - `requestReview`/`approvePlan`/`autoApprovePlan` transitions incl. the
    `approval`-revision shape, the `needs_review`-first guard, and the throws;
  - the `orchestration.plan.review` capability (id/category, persistence,
    `plan.approved` emission, and no force-approve of a still-draft plan under a
    required gate);
  - all eight `user_edit` ops (schema-valid + acyclic + `user_edit`-revision-bumping,
    cycle rejection, deliverable rewire, merge rewiring, split part ids);
  - the directive parser (merge/move/parallel/split/rename/set + unsupported → throw)
    and the stage capability persistence path;
  - the plan view renderer (deterministic, head/tasks/DAG/revisions present).
- Full `packages/platform` vitest suite — **194/194 pass** (was 164, +30).
- Repo-wide `npm run check` **green** (exit 0): biome `--error-on-warnings`,
  pinned-deps, ts-imports, shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke.
- `dist` not rebuilt: gitignored build output, no consumer yet (Step 1.4 precedent).

## 4. Scope Notes

- Step 2.11 was the deterministic approval gate + schema-preserving `user_edit` +
  the deterministic textual plan view (the TUI's view data). The interactive TUI
  widget (DAG pane rendering + prompt collection) and the end-to-end orchestrator
  that runs the full pipeline and wires real models are 2.12 (which owns surfacing
  the approved plan to the agent loop through the TUI plan view, per its own text).
- Edits are deliberately DAG-preserving in the plan-content sense (dependsOn edges):
  scheduling-order changes, parallelism, and merge/split are covered; a full semantic
  "execution overlay" re-plan is §13/2.12 territory.
- No changelog entry: `packages/platform` has no `CHANGELOG.md` (created in Step 1.2;
  prior planning step reports added none).

## 5. Recommended Next Step

**Step 2.12 — Scheduler + execution overlay + end-to-end (Planning complete).** The
approved-plan state machine this step completes is the consumer for 2.12's minimal
deterministic scheduler: `ready(t)` from `dependsOn`, `next` by priority then id,
resolving `requiredCapabilities` to registry capabilities; the hybrid `/plan` +
complexity auto-trigger; and the orchestrator that chains 2.4–2.11 into
request → approved plan, wiring real models and the TUI plan view surface. Per
`docs/planning/PLANNING_STEPS.md`, that closes the Planning gate; the recommended
next feature is roadmap #3 (Workspaces) or a lean-slice handoff to #7.
