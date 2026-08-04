# Planning (ROADMAP Step 2) — Substep Decomposition

**Status:** Step 2.1 complete; steps 2.2–2.12 planned. No store / pipeline implementation yet.
**Master design:** `docs/PLANNING_ARCHITECTURE.md` (the canonical spec — every step
below resolves one ability defined there).
**Format:** mirrors the Step 1 cadence — one capability or service per step; each
step gets a `*_DESIGN.md` (pre-implementation) and `*_REPORT.md` (post-implementation
with a "Recommended Next Step") in `docs/planning/`. This file is the staked-out
substep sequence; it will change as steps are worked.
**Boundary:** Planning ends at an **approved plan** plus a minimal deterministic
scheduler that closes the loop on a walking skeleton. The full task/execution engine
(parallel execution, resume/retry, progress, human checkpoints) is roadmap **#7
Task/Execution Engine** — deliberately out of scope for item 2.

---

## Guiding split reminder (from the architecture)

- **Plan content vs execution state** never merge (§5): the plan is the persisted,
  versioned artifact (revisions); the execution overlay is runtime-owned, per-run,
  discardable.
- **Deterministic orchestration; AI only for reasoning** (§6.4): Goal Analysis,
  Execution Strategy, Constraint Extraction, Task Decomposition, Critic, Optimizer,
  Metrics(subjective) are AI; Clarification Gate, Dependency Builder (rules),
  Validation, Metrics(DAG-derived), Scheduler, Replanning triggers are deterministic.
- **Stage isolation** (§6.2, §11): every AI stage produces strict JSON against a
  per-stage TypeBox schema; one retry on validation failure, then deterministic
  degrade (optional stages skipped; mandatory stages abort with a diagnostic).
- **Per-stage model routing (confirmed requirement):** every AI stage runs on a
  model *chosen for that stage's purpose*, not the model currently selected in the
  user's pi config. Cheap stages (the complexity/Goal-Analysis judgment) use a
  small, cheap model; expensive stages (Task Decomposition, Critic/Optimizer) can
  use a more capable one. The stage contract therefore carries an explicit
  model selector, resolved independently of the session's selected model.
- **Plans are a platform capability, not a prompt** (§16): stages are
  `orchestration`-category capabilities; the scheduler is kernel-side code, never a
  capability.

## Testing requirement (every step)

Every step ships automated tests before it is considered done (per repo test
conventions; run through `test.sh`/per-package vitest, never the full e2e suite).
The architecture makes this tractable:

- **Deterministic stages** (Dependency Builder rules, acyclicity, Validation,
  Clarification Gate, Metrics `parallelism`, scheduler, status transitions) get
  pure unit tests over real inputs.
- **AI stages** get contract tests that pin each stage to its strict TypeBox
  `outputSchema`, plus the two failure paths from §11: one-retry-on-invalid-JSON,
  then deterministic degrade (skip optional stage / abort mandatory stage with a
  diagnostic naming the stage + validation errors).
- **End-to-end** beats run a real staged fixture (fixed fake/recorded LLM outputs for
  the AI stages) through the full pipeline to an approved plan, asserting the plan
  object, revision history, DAG acyclicity, metrics, events, persistence, and the
  scheduler's execution overlay each hold their contracts.
- The plan store (2.2), event surface (2.3), and entry-point trigger (2.12) get
  their own integration tests against in-memory/per-test storage so a stage or
  wiring regression is attributed to exactly one step.

---

## Step 2.1 — Plan object (canonical schema) — DONE

**Report:** `docs/planning/PLAN_OBJECT_REPORT.md` · **Design:** `docs/planning/PLAN_OBJECT_DESIGN.md`

**Implemented:** canonical TypeBox schemas in `@earendil-works/pi-platform`
(`/plan` contracts at `packages/platform/src/plan/index.ts`, `/schema/plan.ts`
constants, `@earendil-works/pi-platform/plan` subpath): `Goal`, `Assumption`,
`Constraint`, `Task`, `PlanningPolicy`, `Revision`, `Plan`, `Metrics` + the
`status` and `revision reason` enums. The §5 split is structural (`Task` has
`additionalProperties: false`, no execution fields); `requiredCapabilities` is
`CapabilityId`-validated. Decisions made: placement follows Step 1.2 contract
discipline; `maxClarificationRounds` (architecture §9) deferred to the 2.4
Clarification Gate; the planning `Plan` is exported via the `/plan` subpath
only (root `Plan` name owned by the pre-existing orchestration `Plan`). 14 unit
tests green; repo `npm run check` green.

**Arch refs:** §4 (canonical schema), §14 (`Metrics`).
**Recommended next step:** the plan store, so the schema has a real owner (2.2).

## Step 2.2 — Plan store + scope + persistence — DONE

**Report:** `docs/planning/PLAN_STORE_REPORT.md` · **Design:** `docs/planning/PLAN_STORE_DESIGN.md`

**Implemented:** `PlanStore` in `@earendil-works/pi-platform/kernel`
(`packages/platform/src/kernel/plan-store.ts`): project/workspace-scoped,
on-disk-JSON source of truth (`<root>/plans/<planId>.json`), read-through with
no cache (external edits never drift), atomic writes, and the §8 full-document
re-store per revision via `revise()`. Validates on save/load against
`PlanSchema`; plan ids filename-safe. 13 unit tests green; repo `npm run check`
green.

**Arch refs:** §8 (versioning), §15 (where the plan lives), §16 (plan store).
**Recommended next step:** the planning capability skeleton, so stages can read/write
the store through the platform (2.3).

## Step 2.3 — Planning capability skeleton + stage contract — DONE

**Report:** `docs/planning/PLANNING_SKELETON_REPORT.md` · **Design:** `docs/planning/PLANNING_SKELETON_DESIGN.md`

**Implemented:** the generic planning-stage pattern in
`@earendil-works/pi-platform/planning` (`packages/platform/src/planning/`): stage
contract (`systemPrompt` + `inputs` + `outputSchema`), the §11 shared strict-JSON
runner (`runStrictJsonStage`: validate → one retry → skip-optional / abort-
mandatory), per-stage model routing (`StageModelRouting`/`resolveStageModel`,
independent of the session model), `definePlanningStageCapability` (stage as
`orchestration` capability, requiring `fs`+`events`, store wired via
`ctx.fs.getWorkspaceRoot()`), the planning event surface (`plan.created`/
`approved`/`replanning`/`completed`), and one trivial non-AI stage
(`orchestration.plan.create`) run end-to-end in a kernel runtime (persists via
the store, emits `plan.created`). 8 unit tests green; repo `npm run check` green.

**Arch refs:** §6.2 (stage contract), §11 (error containment), §16 (stages as
`orchestration` capabilities, events).
**Recommended next step:** the first real AI stage, Goal Analysis (2.4).

## Step 2.4 — Goal Analysis + Clarification Gate — DONE

**Report:** `docs/planning/GOAL_ANALYSIS_REPORT.md` · **Design:** `docs/planning/GOAL_ANALYSIS_DESIGN.md`

**Implemented:** the first real AI planning stage in `@earendil-works/pi-platform/planning`
(`packages/platform/src/planning/goal-analysis.ts` + `clarification-gate.ts`).
`goalAnalysisStage(completion, routing?)` is an `orchestration` capability
(`orchestration.goal.analysis`) producing strict `Goal` JSON against the 2.1
`GoalSchema`, routed to a purpose-chosen cheap model via the `goal_analysis` key
(decoupled from the session model), executed through the §11 `runStrictJsonStage`
(mandatory — aborts with a stage-naming diagnostic on persistent invalid output).
The deterministic `runClarificationGate(goal, opts)` decides `clear` /
`needs_clarification` (surfacing `goal.clarificationQuestions`) /
`proceed_with_unknowns` (unknowns → low-confidence `Assumption`s) within
`maxRounds` (default 2), re-running Goal Analysis only on each loop pass. Model
resolution is settings-shaped (`stageModelRoutingFromSettings`) and guarded
(`requireStageModel` fails loudly when unconfigured). 11 unit tests green; repo
`npm run check` green.

**Arch refs:** §6.3.1 (Goal Analysis), §9 (clarification), §6.4.
**Recommended next step:** Execution Strategy Selection (2.5).

## Step 2.5 — Execution Strategy Selection (first-class) — DONE

**Report:** `docs/planning/EXECUTION_STRATEGY_REPORT.md` · **Design:** `docs/planning/EXECUTION_STRATEGY_DESIGN.md`

**Implemented:** the first-class Execution Strategy Selection
(`packages/platform/src/planning/execution-strategy.ts`): `executionStrategyStage`
is an `orchestration` capability (`orchestration.strategy`) emitting strict
`PlanningPolicy` JSON against `PlanningPolicySchema`, routed via the
`execution_strategy` model key through the §11 runner (mandatory). The policy is
stored on the plan (`plan.policy`, validated by `PlanSchema`) and is part of every
downstream stage's input set (§6.6). Plus the deterministic guard hook
(`packages/platform/src/planning/policy.ts`): `downgradePolicy` never upgrades —
caps `planningDepth` downward, only disables parallel/specialist/dual-planner,
only forces approval (§7). 7 unit tests green; repo `npm run check` green.

**Arch refs:** §7 (why first-class), §6.3.2, §6.6 (policy drives everything).
**Recommended next step:** Constraint Extraction, which can deterministically downgrade
policy (2.6).

---

## Step 2.2 — Plan store + scope + persistence

**Arch refs:** §8 (versioning), §15 (where the plan lives: session/project/user
scoped — `SessionService` vs a plan store), §16 (stored via the session/plan store).
**Confirmed decisions:**
- **Scope: project/workspace-scoped.** Plans live in the working tree (e.g. a
  `plans/` directory), not only in the per-session dir. This is the right call for
  roadmap #3 (Workspaces) — a plan belongs to the workspace, survives sessions,
  and is shareable alongside the tree.
- **On-disk JSON is the durable source of truth** (explicitly *not* in-memory-only).
  The JSON files on disk are what persist; TUI and agent read/write them; the user
  may edit them directly in any editor.
- **Read-through so external edits never drift:** the plan is re-read from disk at
  the point of use (no stale in-memory copy that diverges). External edits are
  picked up via mtime/stat checks now, and via `fs.watch` once the Event System
  (#4) lands. The `user_edit` capability writes back to the same JSON.
**Decisions this step must make:**
- Exact on-disk layout (per-plan JSON + revision history files; naming, index).
- How read-through/change detection is exposed to the plan store (stat-based now).
- Revision model: full document re-store per revision; `revisions` history query.
**Deliverable:** a plan store that saves/loads/lists plans on disk, retains revision
history, and always serves the freshest on-disk content so editor edits are respected.
**Recommended next step:** the planning capability skeleton, so stages can read/write
the store through the platform (2.3).

---

## Step 2.3 — Planning capability skeleton + stage contract

**Arch refs:** §6.2 (stage contract), §11 (error containment), §16 (stages as
`orchestration` capabilities, events).
**Decisions this step must make:**
- The generic stage contract shape: `{ systemPrompt, inputs, outputSchema }` and the
  shared strict-JSON execution helper (validate → one retry with error → degrade).
- **Per-stage model routing resolution:** *where* each AI stage's model selector
  resolves from — a settings/config mapping keyed by stage (independent of the
  session's currently-selected model), resolved at the stage contract level. This
  is what lets Goal Analysis/complexity run on a cheap model while later stages run
  on capable ones.
- The stage capability manifest/export shape (category `orchestration`).
- The planning event surface: `plan.created`, `plan.approved`, `plan.replanning`,
  `plan.completed` over the existing `EventBusService`.
**Deliverable:** a walking skeleton — one trivial (non-AI) stage runs end-to-end as an
`orchestration` capability, persists via the 2.2 store, emits an event. Establishes the
pattern every later stage follows.
**Recommended next step:** the first real AI stage, Goal Analysis (2.4).

---

## Step 2.4 — Goal Analysis + Clarification Gate

**Arch refs:** §6.3.1 (stage 1), §9 (clarification), §6.4.
**Decisions this step must make:**
- Where `requiresClarification` / `clarificationQuestions` live on the `Goal`; the
  deterministic gate's bounded rounds and the re-run of Goal Analysis only (not the
  whole pipeline).
- **Goal Analysis runs on a purpose-chosen cheap model** (per the model-routing
  principle above), decoupled from the session's selected model. The same cheap
  model backs the complexity judgment used by the auto-trigger (2.12).
**Deliverable:** the `GoalAnalysis` AI capability (strict `Goal` JSON, cheap-model
routed) + the deterministic Clarification Gate that pauses, surfaces questions, and
loops back within the bound.
**Recommended next step:** Execution Strategy Selection (2.5) — the highest-leverage
stage, keeping the "one policy, consumed by all" invariant.

---

## Step 2.5 — Execution Strategy Selection (first-class)

**Arch refs:** §7 (why first-class), §6.3.2, §6.6 (policy drives everything).
**Decisions this step must make:** the `PlanningPolicy` enumerations; how policy
becomes part of *every* downstream stage's input set.
**Deliverable:** `PlanningPolicy` capability whose output is stored on the plan and
threaded into later stages; the "policy drives behavior" plumbing (depth, parallelism,
approval, dual planner flags) with the deterministic guard hook for constraints.
**Recommended next step:** Constraint Extraction, which can deterministically downgrade
policy (2.6).

---

## Step 2.6 — Constraint Extraction

**Arch refs:** §6.3.3, §7 (deterministic downgrade rule: hard limits cap policy, never
upgrade).
**Decisions:** how runtime context feeds in; the four constraint families
(hard/soft/resource/policy) folding into `Plan.constraints`; the downgrade merge rule.
**Deliverable:** constraints collection + deterministic policy-downgrade applied to the
stored `PlanningPolicy`.
**Recommended next step:** Task Decomposition (2.7).

---

## Step 2.7 — Task Decomposition

**Arch refs:** §6.3.4 (unordered, unprioritized tasks; dedupe pass; no ordering/deps),
§6.2, §11 (mandatory stage — abort on repeated validation failure).
**Decisions:** input set (goal, constraints, policy, capabilities, skills/memory);
`maxTasks` budget enforcement.
**Deliverable:** the Task Decomposition AI capability producing the unordered task list
+ a deterministic dedupe pass.
**Recommended next step:** Dependency Builder, the first deterministic orchestration
core (2.8).

---

## Step 2.8 — Dependency Builder (DAG)

**Arch refs:** §6.3.5 (deterministic rules in order, bounded AI fallback, acyclicity),
§4 (edges folded into `dependsOn`).
**Decisions:** the deterministic edge rules; when the bounded AI fallback may run;
acyclicity validation feeding `circularDependencies` to the Critic.
**Deliverable:** a module that builds the task DAG deterministically, folds edges into
`dependsOn`, and always validates acyclicity.
**Recommended next step:** the Critic + Optimizer pair (2.9).

---

## Step 2.9 — Plan Critic + Optimizer

**Arch refs:** §6.3.6/7 (adversarial pass and refinement), §6.2/§11 (optional stages —
skip on behalf of second failure), §8 (revisions `critic`/`optimizer` reasons).
**Decisions:** the critique schema; how optimizer revisions preserve goal/intent and
record `changedTaskIds`; merged-plan handling if dual planning (later).
**Deliverable:** Critic capability (finds missing/duplicate/circular/risks) + Optimizer
capability (improves within intent); both schema-validated and degrade-if-failing.
**Recommended next step:** Plan Validation + Metrics (2.10).

---

## Step 2.10 — Plan Validation + Metrics

**Arch refs:** §6.3.8 (deterministic validation: schema, acyclicity, coverage), §6.3.9 +
§14 (`Metrics`: parallelism DAG-derived; completeness/confidence/risk/unknowns
AI-assessed, non-mutating).
**Decisions:** the coverage rules (every success criterion reachable; every task has a
purpose; no duplicate deliverables); the small non-mutating AI metrics prompt and
`parallelism` computation.
**Deliverable:** deterministic validator (failure = pipeline bug → producing stage's
retry/degrade path) + Metrics set on the plan.
**Recommended next step:** User Review / approval (2.11).

---

## Step 2.11 — User Review / approval gate

**Arch refs:** §6.3.10 (human gate), §8 (status transitions `needs_review → approved`),
§15 open question (interactive UX: inline editor vs selector; DAG rendering), §10.
**Confirmed decisions:**
- **Viewable and editable by the user, both on disk and in the TUI.** The on-disk
  JSON (2.2) is the editable source of truth; the TUI is a dedicated plan view, not
  just chat output.
- **Dedicated TUI plan view** (a list plus a drill-in DAG/task view for a selected
  plan) so richer features can be added later. The user interacts with it via
  prompts ("merge/split/move/parallel…"), driving the schema-preserving `user_edit`
  path — with the option to edit the JSON directly, which the TUI/agent pick up via
  read-through (2.2).
**Decisions this step must make:**
- Gate behavior per `policy.requireApproval` (default true for `planningDepth ≥ medium`).
- The schema-preserving `user_edit` capability applying conversational edits and
  bumping `revisions`.
- The TUI surface (command/pane binding) for rendering the DAG and collecting approval.
**Deliverable:** approval flow that flips `needs_review → approved`, a working
`user_edit` path, and a TUI plan view that renders and accepts prompts for changes.
**Recommended next step:** the deterministic scheduler + end-to-end integration (2.12).

---

## Step 2.12 — Scheduler + execution overlay + end-to-end (Planning complete)

**Arch refs:** §5 (execution overlay), §6.5 (scheduler is code, never the LLM),
§12 (scheduling/execution contract), §16 (actions = capability executions).
**Decisions this step must make:**
- The execution overlay model (status/attempts/responsible executor/results) kept
  strictly separate from plan content.
- The minimal deterministic scheduler: `ready(t)` from `dependsOn`, `next` by priority
  then id, resolving `requiredCapabilities` to registry capabilities — a walking
  skeleton only (full parallel/resume/retry is #7).
- **The entry-point trigger — how the user reaches planning (confirmed hybrid):**
  - **(b) explicit command** — `/plan <request>` always runs the pipeline.
  - **(c) automatic for complex prompts** — when a prompt is deemed complex enough
    to warrant a plan *before* execution, planning engages without being asked.
  - **Complexity detection (both, layered):** a cheap **deterministic pre-filter**
    (prompt length, tool-call volume, token/scope estimate) as a first gate; then an
    **AI judgment** via Goal Analysis on a purpose-chosen **cheap model** (see 2.4
    model routing) that decides whether full planning is warranted. This deliberately
    keeps the cheap judgment off the expensive models used by later stages.
- When it integrates with the agent loop: how an approved plan is surfaced for review
  through the TUI plan view (see 2.11) and how the minimal scheduler demos
  plan→execution.
**Gate — Planning complete:** a request reaches the pipeline via `/plan` or the
complexity auto-trigger, flows through all of §6.3's stages into an approved plan
(validated, with metrics, on-disk, reviewable, editable in TUI or any editor), and a
minimal deterministic scheduler resolves a ready task to a capability execution. Full
autonomous multi-task execution is roadmap #7.
**Recommended next step:** roadmap #3 (Workspaces) or, if execution depth is wanted
first, a lean-slice handoff to #7 Task/Execution Engine.

---

## Notes

- **Order rationale:** schema before store (store validates against the schema), store
  before skeleton (skeleton persists through it), then the AI stages in pipeline order
  so each stage feeds the next — matching the architecture's §6.3 sequence, with the
  shared stage contract (2.3) established before any real AI stage.
- **Dual planning (§10)** is policy-gated and off by default; it is not its own step.
  Implement it as an optimizer-adjacent extension when a consumer needs `dualPlanner:
  true`.
- **Full execution** (parallel scheduling, resume, retry, progress, approval
  checkpoints) is roadmap #7, not item 2. Item 2's scheduler is the minimal
  proof-of-life for the plan→execution contract. So after #2 you can produce,
  review, edit, approve, and minimally execute a plan; autonomous multi-task
  run-through comes with #7.
- **Plans are not automatic on every prompt.** The trigger is hybrid (Step 2.12):
  explicit `/plan`, plus automatic engagement when the deterministic + cheap-AI
  complexity check deems the prompt complex enough to warrant a plan. Simple prompts
  never route through planning.
- **Per-stage model routing is a confirmed requirement**: AI stages each pick a
  purpose-chosen model, decoupled from the session's selected model — cheap stages
  (complexity judgment, Goal Analysis) on cheap models, expensive stages on capable
  ones. How the per-stage selector resolves from config is decided at 2.3.
- **Replanning (§13) scope split.** In #2: the replanning *data model* (the
  `replanning` status, `Revision.reason: "replan"`, `changedTaskIds`) and the
  non-execution triggers (user requests a change, user edits the policy, an
  assumption is invalidated — each limited to subtree rewrite, not a full
  regenerate). Execution-verification-driven replanning (N consecutive failures,
  §13) lands in roadmap #7 where verification actually runs.
- **Explicitly deferred — not item 2** (from architecture §15 open questions):
  metric calibration across plan sizes/kinds; escalating `dualPlanner` merge
  conflicts to the user instead of resolving deterministically; persisting the
  execution overlay for resume (that's #7). They are acknowledged here so they are
  never assumed to be in scope for a Planning step.
- Every step's report ends with a "Recommended Next Step"; the sequence above is the
  current view and will be revised as steps are worked (the same caveat as Steps
  1.7–1.10).
