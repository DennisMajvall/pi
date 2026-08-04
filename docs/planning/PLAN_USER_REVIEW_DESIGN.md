# Planning (ROADMAP Step 2) — User Review / approval gate: Design (Step 2.11)

**Status:** Design (pre-implementation)
**Based on:** `docs/PLANNING_ARCHITECTURE.md` §6.3.10 (human gate), §8 (status
transitions `needs_review → approved`, `RevisionReason.approval` / `user_edit`),
§14 (metrics drive the gate), §15 (open question: approval UX); `docs/planning/PLANNING_STEPS.md`
Step 2.11; `docs/planning/PLAN_VALIDATION_METRICS_REPORT.md` (Step 2.10 recommended
next step = 2.11)
**Package:** `@earendil-works/pi-platform` (`/planning` subpath)
**Date:** 2026-02-08

---

## 1. Objective

Close the planning pipeline with the human gate: a finished, validated, scored
`draft` plan is presented for review; the user converses with it (merge/split/move/
parallel/policy edits) and finally approves it, flipping `needs_review → approved`
(§6.3.10). This produces the approved plan the 2.12 scheduler executes.

Three behaviors, all **deterministic** (never an AI decision):

1. **Gate behavior** honors `policy.requireApproval` (default `true` for
   `planningDepth ≥ medium`, set by Execution Strategy Selection). Approval is a
   pure status transition, not a model judgment.
2. **Schema-preserving `user_edit`**: a small deterministic edit engine applies
   conversational edits ("merge tasks 3 and 4", "move deployment after testing",
   "run frontend/backend in parallel", "split auth") and records a `user_edit`
   revision (§8) with the changed task ids. The result always validates against
   `PlanSchema` and stays a DAG (a cycle-inducing edit is rejected).
3. **A dedicated plan view** — a deterministic, textual render of the plan (head,
   task list, DAG outline, revision history) that is the shared view source for the
   on-disk review and the TUI plan view (2.12 wiring surfaces it to the agent loop).

## 2. Placement

Implementation in the `/planning` subpath, reusing 2.1's `Plan`/`RevisionReason`/
`PlanStatus`/`PlanSchema`, 2.2's `PlanStore`, 2.8's acyclicity checker, and the new
2.10 `analyzeDag`:

| Artifact | Location |
| --- | --- |
| Approval gate (pure transitions + capability) | `packages/platform/src/planning/user-review.ts` (new) |
| Schema-preserving edit engine + parser + capability | `packages/platform/src/planning/user-edit.ts` (new) |
| Deterministic plan view renderer | `packages/platform/src/planning/plan-view.ts` (new) |
| Re-export | `packages/platform/src/planning/index.ts` |
| Tests | `packages/platform/test/plan-review.test.ts` (new) |

No contract-module changes (`RevisionReason.approval`/`user_edit` and the status
enum already exist from Step 2.1).

## 3. Approval gate (§6.3.10, §8)

Pure, testable transitions (each returns a new plan; the caller persists via the
PlanStore):

- `evaluateReviewGate(plan)` → `{ kind: "required" }` when `policy.requireApproval`
  is true, else `{ kind: "auto_approved", reason }`.
- `requestReview(plan)` moves a finished `draft → needs_review` (no revision —
  review changes no tasks).
- `approvePlan(plan)` flips `needs_review → approved`, appending an
  `approval` revision (§8) with no task changes. Throws from any other status.
- `autoApprovePlan(plan)` flips `draft|needs_review → approved` for a waived
  policy, also recording an `approval` revision.

The `orchestration.plan.review` capability wraps the flow: load → transition
(honoring the gate) → save → emit `plan.approved`. It will not force-approve a
still-`draft` plan whose policy requires approval: it moves it to `needs_review`
instead.

## 4. Schema-preserving `user_edit` (§6.3.10)

`applyPlanEdit(plan, edit)` is the engine; `edit` is the typed `PlanEdit` union
(the TUI/agent surface). `parsePlanEdit(directive, plan)` additionally translates
the architecture's conversational one-liners into `PlanEdit`, resolving task
references by id, `t<N>` form, or title (with a `tasks? ` prefix tolerance).

Edit ops (each bumps the `user_edit` revision with the changed task ids):

| Op | Meaning | DAG/schema guarantee |
| --- | --- | --- |
| `rename` | retitle a task | none needed |
| `repurpose` | change purpose/deliverable; rewires downstream `inputs` referencing the old deliverable | none needed |
| `add_dependency` | "move X after Y" — adds `dependsOn` edges | rejected (throws) if it would introduce a cycle |
| `remove_dependency` | "run X in parallel with Y" — drops the edge in the direction it exists | always acyclic |
| `merge` | combine tasks into one; dependents rewired to the merged id | removed ids pruned from deps |
| `split` | split a task into parts with derived ids (`t1-1`, `t1-2`); dependents wait on all parts | acyclic by construction |
| `add_constraint` | append a constraint | none needed |
| `set_policy` | set a policy field, validated against `PlanningPolicySchema` | none needed |

Every edit ends in `finalize`: an acyclicity re-check (via 2.8's
`findCircularDependencies`), a `dependsOn`-references-existing-ids check, and a
`Value.Check(PlanSchema)` guard — so the stored plan is always schema-valid and a
DAG. The `orchestration.plan.edit` capability wraps load → apply → save, accepting
either a typed edit or a directive string.

## 5. Plan view (§6.3.10)

`renderPlanView(plan)` renders the full review document: head (id, status, version,
gate, metrics), constraints, assumptions, task list (with deps), the DAG as an
indented outline (`renderPlanDag`, using 2.10 `analyzeDag` diagnostics, with a
per-path cycle guard), and the revision history (`renderRevisionHistory`). Pure and
deterministic — it is the shared view source for on-disk review and the TUI plan
view.

## 6. TUI surface — decision

The architecture §15 open question ("Approval UX: inline editor vs selector; how to
render the DAG") is settled by this step as: **the interactive TUI widget is the
2.12 wiring surface.** This step ships the deterministic platform core — the gate,
the editable plan, and the textual DAG/task renderer — which is exactly what the TUI
plan view displays and what 2.12's agent-loop integration ("surfaces the approved
plan for review through the TUI plan view", PLANNING_STEPS Step 2.12) consumes.
Prior steps (2.1–2.10) stayed purely in `packages/platform`; the interactive TUI
widget (pane/command binding + prompt collection) is scoped to 2.12 alongside the
orchestrator and real model wiring, keeping this step testable in `packages/platform`
with no TUI-runtime coupling.

## 7. Test plan

`test/plan-review.test.ts`: gate decision; the four status transitions (incl. the
approval revision shape and the throws); the review capability (id, persistence,
`plan.approved` emission, no force-approve of a draft under a required gate); all
eight edit ops (schema-valid + acyclic + revision-bumping, incl. cycle rejection and
deliverable rewire); the directive parser (merge/move/parallel/split/rename/set,
unsupported → throws); and the view renderer (deterministic, contains head/DAG).
