# Pi Roadmap

Every line is one feature or step, checked off one by one as it is implemented.
The numbered features are the same as in `docs/features-to-implement.md`
(original numbers in parentheses). The order is the **build order** from that
document's compressed list: the original numbering put Memory at #4, but
Memory's prerequisites (event system, background workers) come first.

## Path to Memory (the goal)

Capability Platform → Planning → Workspaces → Event System → Background
Workers → **Memory** (features-to-implement #4)

## 1. Capability Platform (features-to-implement #1) — complete

- [x] Step 1.2 — Contracts package (`@earendil-works/pi-platform`)
- [x] Step 1.3 — Runtime kernel + read tool
- [x] Step 1.4 — bash tool + ProcessService
- [x] Step 1.5 — grep tool + first peer-capability dependency
- [x] Step 1.6 — SettingsService
- [x] Step 1.7 — SessionService
- [x] Step 1.8 — find/ls + grep search seam (read-only tool set complete)
- [x] Step 1.9 — write/edit migration (fs write surface + first write permission; shared tool-execution helper)
- [x] Step 1.10 — **Capability Platform complete** (gate: the platform is the
      default execution path for all builtin tools, not a silent fallback)

## 2. Planning (features-to-implement #2) — designed

Detailed substeps and per-step decisions live in
`docs/planning/PLANNING_STEPS.md` (per-step design/report docs are added to
`docs/planning/` as each step is worked).

- [x] Step 2.1 — Plan object: canonical TypeBox schemas (Goal, Assumption,
      Constraint, Task, PlanningPolicy, Revision, Plan, Metrics) + status enum
      (`docs/planning/PLAN_OBJECT_DESIGN.md` / `PLAN_OBJECT_REPORT.md`)
- [x] Step 2.2 — Plan store: project/workspace-scoped on-disk JSON is the durable
      source of truth (not in-memory); read-through so external edits never drift
      (`docs/planning/PLAN_STORE_DESIGN.md` / `PLAN_STORE_REPORT.md`)
- [x] Step 2.3 — Planning capability skeleton: the generic stage contract
      (systemPrompt + inputs + outputSchema; per-stage model routing), strict-JSON
      exec + retry + degrade path, and the planning event surface; one trivial
      stage end-to-end
      (`docs/planning/PLANNING_SKELETON_DESIGN.md` / `PLANNING_SKELETON_REPORT.md`)
- [x] Step 2.4 — Goal Analysis stage (cheap purpose-chosen model) + deterministic
      Clarification Gate
      (`docs/planning/GOAL_ANALYSIS_DESIGN.md` / `GOAL_ANALYSIS_REPORT.md`)
- [x] Step 2.5 — Execution Strategy Selection (first-class; emits `PlanningPolicy`)
      (`docs/planning/EXECUTION_STRATEGY_DESIGN.md` / `EXECUTION_STRATEGY_REPORT.md`)
- [x] Step 2.6 — Constraint Extraction (deterministic policy-downgrade rule)
      (`docs/planning/CONSTRAINT_EXTRACTION_DESIGN.md` / `CONSTRAINT_EXTRACTION_REPORT.md`)
- [x] Step 2.7 — Task Decomposition (unordered tasks + dedupe pass)
      (`docs/planning/TASK_DECOMPOSITION_DESIGN.md` / `TASK_DECOMPOSITION_REPORT.md`)
- [x] Step 2.8 — Dependency Builder (deterministic rules + bounded AI fallback;
      acyclicity check → DAG)
      (`docs/planning/DEPENDENCY_BUILDER_DESIGN.md` / `DEPENDENCY_BUILDER_REPORT.md`)
- [x] Step 2.9 — Plan Critic + Optimizer (adversarial pass + refinement, stage
      error containment)
      (`docs/planning/CRITIC_OPTIMIZER_DESIGN.md` / `CRITIC_OPTIMIZER_REPORT.md`)
- [x] Step 2.10 — Plan Validation + Metrics (deterministic schema/DAG/coverage +
      AI-assessed score)
      (`docs/planning/PLAN_VALIDATION_METRICS_DESIGN.md` / `PLAN_VALIDATION_METRICS_REPORT.md`)
- [x] Step 2.11 — User Review / approval gate (status transitions; schema-
      preserving `user_edit`; on-disk + dedicated TUI plan view, editable via
      prompts) (`docs/planning/PLAN_USER_REVIEW_DESIGN.md` / `PLAN_USER_REVIEW_REPORT.md`)
- [ ] Step 2.12 — **Planning complete**: deterministic scheduler + execution
      overlay (plan content vs state split); hybrid trigger (`/plan` + complexity
      auto-engage via deterministic pre-filter + cheap-model AI judgment);
      end-to-end request→approved plan (full execution engine is roadmap #7)

## The roadmap (build order)

- [x] 1. Capability Platform (#1)
- [ ] 2. Planning (#2) — designed (`docs/PLANNING_ARCHITECTURE.md`); substeps listed in `## 2. Planning` above; planned in `docs/planning/PLANNING_STEPS.md`
- [ ] 3. Workspaces / Git Worktrees (#3) — designed (`docs/WORKSPACE_ARCHITECTURE.md`); absorbs Step-1 leftovers **M2** (per-exec session identity), **M7** (settings write side), **M8** (session write side), **M12** (real `WorkspaceId`)
- [ ] 4. Event System (#5) — designed (`docs/EVENT_ARCHITECTURE.md`); absorbs **M19** (event replay/history/persistence + `fs.watch`)
- [ ] 5. Background Workers (#6)
- [ ] 6. **Memory (#4)** — designed (`docs/KNOWLEDGE_MEMORY_ARCHITECTURE.md`) — the goal
- [ ] 7. Task / Execution Engine (#7)
- [ ] 8. Subagents (#8)
- [ ] 9. Context Assembly (#10)
- [ ] 10. Workspace Indexing (#9) — absorbs **M15** (fd parity / gitignore-aware glob)
- [ ] 11. Approval Framework (#11) — absorbs **M6** + the `permissions` stub (part of **M5**)
- [ ] 12. Observability (#12) — absorbs **M9**/**M10** (session list gaps) + the `logging`/`telemetry` stubs (part of **M5**)
- [ ] 13. Capability Marketplace (#13) — absorbs **M21** (semver resolution) + **M22** (distribution/discovery) + the `network`/`auth`/`cache`/`configuration` stubs (part of **M5**)
- [ ] 14. Policies / Rules (#14) — completes **M6** enforcement policies
- [ ] 15. Reflection (#15)
- [ ] 16. Knowledge Management (#16)
- [ ] 17. Automation / Triggers (#17)
- [ ] 18. Multi-Agent Collaboration (#18)

## Notes

- **Open leftovers from Capability Platform (Step 1) are code-verified and tracked in
  `docs/CAPABILITY_PLATFORM_STEP1_LEFTOVERS.md` (Part 7).** Each is resolved by the
  roadmap step that owns it, in build order (the "absorbs Mx" notes on items 3/4/10/
  11/12/13/14). Deliberately **not** scheduled: nice-to-have items M3/M4/M11/M13/M14/
  M16/M20/M25/M27/M28 (no current consumer), keep-items M17/M18/M26, and M1 (a deferred
  human decision gate — `docs/RUNTIME_MODEL.md`). All of them live only in the LEFTOVERS
  tracker; they are not pre-loaded onto any feature.

- **Concurrency & parallelism:** the three axes (runtime scoping A, filesystem
  isolation B, in-process scheduling C) and the M1 per-session-runtime decision gate are
  **not roadmap material** — they live in `docs/RUNTIME_MODEL.md`. In short: no item owns
  Axis A; Workspaces (3) is Axis B; Event/Workers/Task/SubAgents (4/5/7/8) are Axis C on
  the single kernel.
- Current position: Step 1.10 (the gate) is complete — **Capability Platform
  (ROADMAP item 1) is done**. `_buildRuntime` consumes the platform tool set
  atomically (all seven builtin tools or none): the platform is the default
  execution path, legacy is the explicit wholesale fallback with a loud
  warning, and no mixed platform/legacy session state is possible. The
  seven `buildXToolDefinition` adapters collapsed into one generic builder
  driven by a per-tool spec table, and the manifests' `provides.tool` prose
  is sourced from the tool templates (a fixture pins manifest↔tool equality).
  Next: Planning (`docs/PLANNING_ARCHITECTURE.md`).
- Current position (Planning): Steps 2.1–2.10 complete — the canonical Plan object
  (Goal/Assumption/Constraint/Task/PlanningPolicy/Revision/Plan/Metrics +
  status & revision-reason enums) is a validated TypeBox schema in
  `@earendil-works/pi-platform` (`/plan` subpath); a `PlanStore` (`/kernel`) owns
  it as project/workspace-scoped on-disk JSON (`<root>/plans/<planId>.json`),
  read-through (no cache) with atomic writes and the §8 full-document revision
  re-store; a `/planning` subpath establishes the generic stage pattern (stage
  contract + §11 strict-JSON runner, per-stage model routing independent of the
  session model, stages as `orchestration` capabilities, the planning event
  surface, one trivial stage end-to-end); and the AI stages + deterministic
  folds — Goal Analysis (`orchestration.goal.analysis`, cheap-model routed),
  Execution Strategy Selection (`orchestration.strategy`, strict `PlanningPolicy`
  JSON stored on the plan), Constraint Extraction (`orchestration.constraints`, four
  families folded onto `Plan.constraints`), Task Decomposition
  (`orchestration.tasks`, unordered tasks + dedupe/budget/complete passes), the
  deterministic Dependency Builder (`buildDependencyGraph`, DAG + acyclicity),
  and the Plan Critic + Optimizer pair (`orchestration.critic`/`orchestration.optimizer`,
  optional §11 stages, `critic`/`optimizer` revisions) — plus the deterministic §9
  Clarification Gate, the never-upgrades policy guard hook (§7), the constraint-driven
  downgrade rule, and Step 2.10's Plan Validation + Metrics: the deterministic
  `validatePlan` (schema / re-run acyclicity / coverage — reachable criteria, task
  purposes, no duplicate deliverables) and the Planning Metrics (DAG-derived
  `parallelism` via `analyzeDag`/`computeParallelism`, the optional non-mutating AI
  `metricsStage`, and `combineMetrics` onto the §14 `Metrics` set on the plan)
  — plus Step 2.11's User Review / approval gate: the deterministic gate
  (`evaluateReviewGate` honors `policy.requireApproval`, default true for medium+),
  the `needs_review → approved` transition recording an `approval` revision, the
  `autoApprovePlan` path for waived policies and the `orchestration.plan.review`
  capability (emits `plan.approved`); the schema-preserving `user_edit` engine
  (`applyPlanEdit`/`parsePlanEdit`, ops rename/repurpose/add_dependency/remove_dependency/merge/split/
  add_constraint/set_policy, each DAG- + schema-guarded and bumping a `user_edit`
  revision) behind the `orchestration.plan.edit` capability; and the deterministic
  plan view (`renderPlanView`/`renderPlanDag`, the TUI's shared view source).
  194 unit tests green, repo check green. Next: the minimal deterministic
  scheduler + execution overlay + end-to-end request→approved plan, which wires
  the orchestrator, real model routing, and the TUI plan view surface (Step 2.12).
- Step cadence: one capability or service per step. Every step's report ends
  with a "Recommended Next Step" section that picks the next cheapest
  validation, grounded in the design docs — this is how steps 1.3–1.10 were
  chosen (each report named the next one in advance), not improvised.
- Sub-steps between features are not pre-planned; they are decided when a
  feature starts (the platform steps 1.7–1.10 above are the current view and
  will change as we go). Planning (item 2) is the active feature: its substeps
  and per-step decisions are staked out in `docs/planning/PLANNING_STEPS.md`
  and will be refined as each step is worked (the same 1.7–1.10 caveat
  applies).
- "Capability Platform complete" is the gate at which the platform stops being
  an optional layer with a silent fallback and becomes the default execution
  path for the builtin tools. That gate closed at Step 1.10: the builtin tool
  set is sourced atomically from the capability registry (all seven or none),
  legacy is the explicit wholesale fallback, and the adapters + manifest
  prose are deduplicated/pinned.
