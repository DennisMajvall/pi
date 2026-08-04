# Pi Planning Skill — Architecture

**Status:** Architecture design (pre-implementation)
**Scope:** Design only. No implementation yet.
**Related:** `docs/CAPABILITY_PLATFORM_CONTRACTS.md`, `docs/capability-platform/RUNTIME_KERNEL_DESIGN.md` (Steps 1.2/1.3)

---

## 1. Goals and Non-Goals

### Goals

- High-quality, precise, effective plans.
- Plans optimized for AI-agent delegation over human task lists.
- Human review before execution.
- Simple architecture, minimal dependencies.
- Deterministic orchestration wherever possible.
- Easy to understand, maintain, extend.

### Non-Goals

- No external orchestration frameworks (LangGraph, CrewAI, AutoGen, Semantic Kernel, etc.). Their functionality is reproduced with Pi's own architecture — a deterministic scheduler, capabilities for AI stages, and events — without unnecessary abstraction or long-term maintenance costs.
- No free-form planning prompts. Every AI stage produces **strict, validated JSON** against a per-stage schema (see §11).

---

## 2. Guiding Principles

1. **Planning is a first-class capability inside Pi**, not a prompt outputting Markdown. The plan is a persistent object independent of execution:
   `Conversation → Plan → [Review, Execute]`
2. **Plans are structured data, never prose.** The runtime owns the plan object; the LLM only creates/edits it via validated JSON.
3. **Deterministic orchestration; AI only for reasoning.** Scheduling, ordering, validation, and cycle detection are code. The LLM never decides execution order.
4. **Four distinct abstraction levels. Never mix them.**
   `Goal → Plan → Task → Action`
5. **Explicit uncertainty.** Every plan exposes assumptions, unknowns, confidence, and missing information.
6. **Incremental plans.** Hierarchical refinement instead of one massive upfront plan.
7. **Many small, focused AI calls over one large prompt.** Each stage consumes only the structured output it needs — not the whole conversation.
8. **User validation before execution.**
9. **Stage isolation.** Each AI stage is independently testable; if one degrades after a model update, the failing stage is identifiable immediately.

---

## 3. Conceptual Model: Four Levels

| Level | Definition | Created by | Owned by | Example |
|-------|-----------|------------|----------|---------|
| **Goal** | What the user wants; one sentence + success criteria + unknowns | User (formalized by Goal Analysis) | User + runtime | "Ship a SaaS billing feature" |
| **Plan** | How to achieve the goal: tasks, dependency edges, policy, assumptions | Planner pipeline (LLM edits, runtime owns) | Runtime | DAG of 12 tasks + policy |
| **Task** | Discrete unit of work with inputs, outputs, dependencies, verification | Task Decomposition (LLM) | Runtime | "Implement JWT auth middleware" |
| **Action** | A single tool call / operation during execution | Executor (agent runtime) | Executor | `read("src/auth.ts")`, `bash("npm test")` |

Rules:

- The **plan** is the persisted artifact. Tasks exist inside the plan. Actions exist only during execution and never appear in the plan document.
- **Plan content and execution state never mix.** A plan's task carries no `status`/`priority`/`responsibleAgent`; those live in a separate execution overlay maintained by the runtime (§5, §12). This keeps plans stable, diffable, and resumable.

---

## 4. The Plan Object (Canonical Schema)

One schema, used by every stage that reads or writes plans. `schemaVersion` guards future evolution. All schemas are **TypeBox** (`typebox` is Pi's schema library — tools, extension schemas, and the platform contracts all use it; see §16).

```ts
// Schema sketches (TypeBox form; exact field docs in the appendix)
const Goal = Type.Object({
  summary: Type.String(),
  successCriteria: Type.Array(Type.String()),
  unknowns: Type.Array(Type.String()),
  requiresClarification: Type.Boolean(),
  clarificationQuestions: Type.Array(ClarificationQuestion), // when requiresClarification
});

const Assumption = Type.Object({
  statement: Type.String(),
  confidence: Type.Number({ minimum: 0, maximum: 100 }),
  source: Type.Union([Type.Literal("user"), Type.Literal("verified"), Type.Literal("inferred")]),
});

const Constraint = Type.Object({
  kind: Type.Union([Type.Literal("hard"), Type.Literal("soft"), Type.Literal("resource"), Type.Literal("policy")]),
  description: Type.String(),
});

const Task = Type.Object({
  id: Type.String(),                    // stable task id
  title: Type.String(),
  purpose: Type.String(),               // why this task exists
  deliverable: Type.String(),           // what "done" produces (used by Dependency Builder)
  inputs: Type.Array(Type.String()),    // artifacts/values consumed
  outputs: Type.Array(Type.String()),   // artifacts/values produced
  dependsOn: Type.Array(Type.String()), // task ids; derived from Dependency Builder edges
  requiredCapabilities: Type.Array(Type.String()), // capability ids; resolved at execution
  verification: Type.String(),          // how completion is verified
});

const PlanningPolicy = Type.Object({
  taskKind: Type.Union([Type.Literal("research"), Type.Literal("implementation"),
    Type.Literal("debugging"), Type.Literal("design"), Type.Literal("maintenance"), Type.Literal("mixed")]),
  planningDepth: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  hierarchicalRefinement: Type.Boolean(),
  parallelExecution: Type.Boolean(),
  specialistAgents: Type.Boolean(),
  requireApproval: Type.Boolean(),
  verificationLevel: Type.Union([Type.Literal("none"), Type.Literal("basic"), Type.Literal("strict")]),
  preferResearch: Type.Boolean(),
  maxTasks: Type.Integer(),
  dualPlanner: Type.Boolean(),          // generate two independent plans, then merge
});

const Revision = Type.Object({
  version: Type.Integer(),              // v1, v2, ...
  reason: Type.Union([Type.Literal("user_edit"), Type.Literal("critic"),
    Type.Literal("optimizer"), Type.Literal("replan"), Type.Literal("approval")]),
  changedTaskIds: Type.Array(Type.String()),
  createdAt: Type.Number(),
});

const Plan = Type.Object({
  id: Type.String(),
  schemaVersion: Type.Literal(1),
  goal: Goal,
  policy: PlanningPolicy,
  constraints: Type.Array(Constraint),
  assumptions: Type.Array(Assumption),
  tasks: Type.Array(Task),
  revisions: Type.Array(Revision),
  status: Type.Union([Type.Literal("draft"), Type.Literal("needs_review"), Type.Literal("approved"),
    Type.Literal("running"), Type.Literal("replanning"), Type.Literal("completed"),
    Type.Literal("failed"), Type.Literal("archived")]),
  metrics: Type.Optional(Metrics),      // set at review time (§14)
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});
```

Notes:

- **Dependencies are canonicalized as edges.** The Dependency Builder emits `{from, to}` edges; the runtime folds them into each task's `dependsOn`. The plan is a DAG — validated deterministically (§6.4).
- **`requiredCapabilities` references platform capability ids** (e.g. `tool.read`, `command.bash`), resolved against the `CapabilityRegistry` at execution. Free-text skill names are not allowed in the plan.

---

## 5. Plan Content vs Execution State

Two separate objects. Never merge them.

| | **Plan** (persisted, versioned) | **Execution overlay** (runtime-owned, per run) |
|---|---|---|
| Task fields | id, title, purpose, deliverable, inputs, outputs, dependsOn, requiredCapabilities, verification | status (`pending/ready/running/blocked/failed/done`), attempt count, responsible executor, started/ended, results |
| Owned by | Runtime (LLM edits via stages) | Runtime scheduler/executor |
| Survives restart | Yes | Optional (resume support later) |
| Versioned | Yes (`revisions`) | No |

Splitting these means:

- The plan diff is meaningful (`revisions.changedTaskIds`).
- Resume/replanning only touches plan content; execution bookkeeping is discardable.
- Multiple execution runs of the same approved plan are possible (dry-run, re-run, resume).

---

## 6. The Planning Pipeline

### 6.1 Canonical stage order

```
User request
     │
     ▼
┌──────────────────┐  ┌───────────────────────┐
│ 1. Goal Analysis │─►│ Clarification Gate    │  deterministic; loop back to 1 with answers
└──────────────────┘  └──────────┬────────────┘   (bounded rounds)
                                 ▼
┌──────────────────────────┐
│ 2. Execution Strategy    │  → PlanningPolicy (shapes all downstream stages)
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐
│ 3. Constraint Extraction │  → constraints (may deterministically cap policy, e.g. hard time limit)
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐      ┌──────────────────────────┐
│ 4. Task Decomposition    │─────►│ 5. Dependency Builder    │  deterministic rules,
└──────────────────────────┘      └────────────┬─────────────┘  AI fallback on ambiguity
                                               ▼
┌──────────────────────────┐
│ 6. Plan Critic           │  adversarial pass (AI)
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐
│ 7. Plan Optimizer        │  refines the draft plan (AI)
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐      ┌──────────────────────────┐
│ 8. Plan Validation       │─────►│ 9. Planning Metrics      │  deterministic where possible
└────────────┬─────────────┘      └────────────┬─────────────┘
             ▼                                 ▼
┌──────────────────────────┐
│ 10. User Review           │  human gate; natural-language edits; approval
└────────────┬─────────────┘
             ▼
┌──────────────────────────┐      ┌──────────────────────────┐
│ 11. Execution (scheduler)│─────►│ 12. Verification &       │  deterministic triggers
└──────────────────────────┘      │     Replanning           │
                                   └──────────────────────────┘
```

Optional stage (policy-gated, `dualPlanner: true`): run **Task Decomposition twice independently**, merge deterministically (union of tasks + edges, dedupe by deliverable), then run Critic on the merged plan. See §10.

### 6.2 Stage contracts

Every AI stage follows the same shape:

```
Stage contract = { systemPrompt, inputs (XML), outputSchema (TypeBox) }
```

- **Inputs** are the previous stages' structured outputs only — never the full conversation (§6.7).
- **Output** is strict JSON validated against `outputSchema`; on failure: retry once with the validation error, then degrade per §11.
- System prompts forbid out-of-scope behavior explicitly (e.g. "do not schedule", "do not estimate effort").

### 6.3 Stage-by-stage

#### 1. Goal Analysis (AI)

- **Purpose:** Transform the user's request into a precise objective. Understand only — do not plan, decompose, or estimate.
- **Inputs:** `<conversation>`, `<user_request>`, `<available_capabilities>`, `<user_preferences>`
- **Output:** `Goal` (summary, successCriteria, unknowns, requiresClarification, clarificationQuestions)
- **Exemplar system prompt** (the pattern all stages follow):

```
SYSTEM: You are Pi's Goal Analysis module. Your only responsibility is
understanding what the user wants. Do not create a plan. Do not decompose
work. Do not estimate effort. Only clarify the objective.
Return valid JSON matching the GoalAnalysis schema.
```

- **Feeds into:** Clarification Gate, Execution Strategy, Constraint Extraction.

#### 2. Execution Strategy Selection (AI, small)

- **Purpose:** Decide *how planning itself should behave* for this request — the single most leveraged stage (see §7). Prevents every downstream stage from independently guessing the same strategy.
- **Inputs:** Goal Analysis output only.
- **Output:** `PlanningPolicy`.
- **Answers:** task kind (research/implementation/debugging/design/mixed); planning depth; hierarchical refinement on/off; parallelism allowed; specialist agents; user approval required; verification level; research preference; max tasks; dual planner.
- **Feeds into:** every downstream stage (policy is part of each stage's input set).

#### 3. Constraint Extraction (AI)

- **Purpose:** Extract every limitation that should influence planning.
- **Inputs:** Goal Analysis output, `<runtime>` context (OS, installed software, available tools, model limits, time limits, permissions).
- **Output:** `{ hardConstraints[], softConstraints[], resourceConstraints[], policyConstraints[] }` → folded into `Plan.constraints`.
- **Deterministic merge rule:** a hard resource/time constraint may *downgrade* policy fields (e.g. hard time limit ⇒ `planningDepth ≤ medium`). Policy is never *upgraded* by constraints.
- **Feeds into:** Task Decomposition, Plan Critic.

#### 4. Task Decomposition (AI)

- **Purpose:** Break the goal into the smallest meaningful tasks.
- **System prompt rule:** never think about execution, scheduling, or optimization — only identify work that must exist.
- **Inputs:** Goal, constraints, policy, available capabilities/skills, memory.
- **Output:** unordered tasks — `[{ id, title, purpose, deliverable }]`. **No ordering, no priorities, no dependencies, no parallelism.**
- **Feeds into:** Dependency Builder.

#### 5. Dependency Builder (deterministic first, AI fallback)

- **Purpose:** Build the task DAG.
- **Deterministic rules, in order:**
  1. Task output matches another task's input/deliverable ⇒ edge (output→consumer).
  2. Required capability is produced by another task (e.g. "test" needs "build artifact") ⇒ edge.
  3. Explicit user/constraint ordering ("deployment after testing") ⇒ edge.
  4. Skill prerequisite (task needs knowledge another task generates) ⇒ edge.
- **AI fallback (bounded):** only when the deterministic pass leaves ambiguous candidate edges. Prompt: "Determine whether these tasks depend on each other. Never invent additional tasks. Never optimize. Return dependency edges only." Output: `[{ from, to }]`.
- **Deterministic validation (always):** acyclicity check (topological sort). Circular edges are reported to the Plan Critic as `circularDependencies`; the runtime never schedules a cyclic graph.
- **Feeds into:** Plan Critic.

#### 6. Plan Critic (AI, adversarial)

- **Purpose:** Try to destroy the plan.
- **System prompt rule:** assume mistakes exist; find them. You are not helping create a plan.
- **Inputs:** Goal, constraints, tasks, dependency edges, policy.
- **Output:** `{ missingTasks[], duplicateTasks[], circularDependencies[], incorrectAssumptions[], risks[], questions[] }`
- **Feeds into:** Plan Optimizer.

#### 7. Plan Optimizer (AI)

- **Purpose:** Improve an already-good plan.
- **System prompt rules:** never redesign the goal; never remove user intent; improve efficiency, reduce unnecessary work, increase parallelism, simplify execution.
- **Inputs:** entire draft plan + critique + policy.
- **Output:** updated `Plan` (same schema). Revisions recorded as `critic`/`optimizer`.

#### 8. Plan Validation (deterministic)

- Schema-validate the full plan.
- Re-run acyclicity check.
- Coverage check: every success criterion is reachable from some task's outputs; every task has a purpose; no duplicate deliverables.
- Failure here is a pipeline bug (stage output violated the contract), not a user error — it triggers the retry/degrade path of the producing stage.

#### 9. Planning Metrics (deterministic where possible, AI for subjective)

- **Computed deterministically from the DAG:** parallelism (width/critical-path ratio), task count vs `maxTasks`, dependency density.
- **AI-assessed (small prompt, no modification):** completeness, confidence, risk, unknown count. "Score the plan objectively. Do not modify it."
- **Output:** `Metrics` (§14).

#### 10. User Review (human)

- Gate before execution when `policy.requireApproval` (default: true for `planningDepth ≥ medium`).
- Edits are conversational: "merge tasks 3 and 4", "split auth", "move deployment after testing", "run frontend/backend in parallel". A small edit capability applies them **schema-preserving** and bumps `revisions` (`user_edit`).
- Approval flips status `needs_review → approved`.

#### 11. Execution (deterministic scheduler)

- Consumes the approved DAG only. See §12.

#### 12. Verification & Replanning

- Per-task verification runs against `Task.verification`.
- Replanning triggers are deterministic; replanning rewrites only the affected subtree. See §13.

### 6.4 Deterministic vs AI boundary

| Stage | Kind | Validation |
|-------|------|-----------|
| Goal Analysis | AI | `Goal` schema |
| Clarification Gate | **deterministic** | — |
| Execution Strategy | AI | `PlanningPolicy` schema (enumerated values) |
| Constraint Extraction | AI | constraints schema |
| Task Decomposition | AI | task schema; deterministic dedupe pass |
| Dependency Builder | **deterministic** + bounded AI fallback | acyclicity (deterministic) |
| Plan Critic | AI | critique schema |
| Plan Optimizer | AI | `Plan` schema + invariants |
| Plan Validation | **deterministic** | schema + DAG + coverage |
| Planning Metrics | deterministic (DAG-derived) + AI (subjective) | numeric ranges |
| User Review | human | — |
| Scheduler | **deterministic** | — |
| Replanning trigger | **deterministic** | — |

### 6.5 The scheduler is code, never the LLM

```
Plan DAG → Runtime Scheduler →
  ready(t) = t unfinished ∧ all t.dependsOn done ∧ resources available
  next    = argmin(ready tasks, by priority, then id)
→ Execute → verify → done
```

Scheduling = code. Planning = AI. The LLM contributes nothing to execution order.

### 6.6 Planning policy drives everything

The `PlanningPolicy` produced by Execution Strategy Selection is part of **every** downstream stage's input. Consequences:

- `planningDepth: low` ⇒ shallow decomposition, single pass, no critic/optimizer round-trip.
- `parallelExecution: false` ⇒ scheduler serializes (edges unchanged; a deterministic constraint in the overlay).
- `dualPlanner: true` ⇒ two decompositions + deterministic merge (§10).
- `verificationLevel: strict` ⇒ every task must carry a non-empty `verification`; validation enforces it.
- `maxTasks` ⇒ decomposition must stay within budget; validator enforces it.
- Simple requests (one-liner, low depth) skip enterprise-scale overhead entirely.

### 6.7 Context flow — explicit, minimal, staged

```
Goal Analysis:        conversation, user request, capabilities, preferences
Execution Strategy:   Goal Analysis output
Constraint Extraction: Goal Analysis output, runtime context
Task Decomposition:   Goal, constraints, policy, capabilities, skills
Dependency Builder:   task list only
Plan Critic:          goal, constraints, tasks, edges, policy
Plan Optimizer:       entire draft plan + critique
Plan Validation:      full plan (deterministic)
Planning Metrics:     final plan only
```

Later stages do **not** inherit the full conversation. They consume structured outputs from previous stages. This minimizes context size, reduces prompt coupling, and makes each stage independently testable (a stage's behavior depends only on its declared inputs).

---

## 7. Execution Strategy Selection (First-Class Stage)

This stage is the single highest-leverage decision in the pipeline: instead of the decomposer implicitly deciding how to solve the problem, an explicit stage answers:

- Is this primarily research, implementation, debugging, design, or mixed?
- Planning depth: low / medium / high?
- Use hierarchical refinement?
- Involve specialist agents?
- Is user approval required before execution?

Why it belongs *right after* Goal Analysis (and before downstream stages): every downstream prompt currently has to infer the same high-level strategy independently, which causes inconsistent depth, contradictory parallelism decisions, and duplicate reasoning across stages. A single policy object, produced once and consumed by all, keeps behavior consistent and makes the strategy inspectable and editable by the user at review time.

One deterministic guard: **Constraint Extraction may downgrade policy fields** (hard limits cap depth, disable parallelism, or force approval), but never upgrades them. Strategy is set by intent; bounded by reality.

---

## 8. Plan Lifecycle and Versioning

```
draft ──► needs_review ──► approved ──► running ──► completed
  ▲            │               │           │
  │            │               │           ├──► failed ──► (fix loop | replan)
  │            │               │           │
  └────────────┴───── replanning ──────────┘
                                          
completed / failed / archived are terminal (archived via user action)
```

- **Transitions are deterministic.** Only explicit triggers move status: stage completion, user approval, verification failure, user edit, replan.
- **Versioning is git-like:** `v1` (draft) → `v2` (user edits) → `v3` (critic/optimizer) → `v4` (post-execution replan). History aids debugging and prompt engineering.
- Each revision records `reason` and `changedTaskIds`; the full plan document is re-stored per revision (plans are small; diffing is trivial).

---

## 9. Clarification

One deterministic gate — not two stages.

- Goal Analysis reports `requiresClarification` and `clarificationQuestions` when the objective is ambiguous or blocking unknowns exist.
- The **Clarification Gate** (deterministic) decides: if `requiresClarification` or any high-priority unknown is blocking ⇒ pause pipeline, surface questions to the user, wait for answers, then re-run **Goal Analysis only** with the answers.
- Bounded rounds (`policy.maxClarificationRounds`, default 2). Exceeding the bound proceeds with the unknowns recorded as low-confidence assumptions — the plan exposes them (§13/§14) rather than stalling.
- No separate "Clarification Generator" stage: questions are a Goal Analysis output field.

---

## 10. Dual Planning (Optional, Policy-Gated)

For high-quality plans (`dualPlanner: true`):

```
Goal → [Planner A → Plan A, Planner B → Plan B] → deterministic merge → Critic → Optimizer → Final Plan
```

- Two independent decompositions reveal different structures and blind spots.
- Merge is deterministic: union of tasks (dedupe by `deliverable`), union of edges, conflict on edge direction resolved by keeping the edge present in both or by criticality order (documented in the revision).
- Cost is bounded: only runs under `planningDepth: high` or explicit user request. Off by default.

---

## 11. Stage Isolation and Error Containment

Every AI stage is independently testable:

1. **Strict JSON output** against a per-stage TypeBox schema (never free-form).
2. **Validation failure ⇒ one retry** with the validation errors appended to the prompt ("your previous output failed validation: ..."). The model corrects the JSON.
3. **Second failure ⇒ degrade deterministically:**
   - Optional stages (Critic, Optimizer, dual planner) are skipped; the plan proceeds.
   - Mandatory stages (Goal Analysis, Task Decomposition) abort with a diagnostic naming the stage and the validation errors.
4. **Logging:** stage name + validation result, so a model-update regression is attributed to exactly one stage.

Deterministic stages never call the LLM (Dependency Builder's AI fallback is bounded, schema-validated, and only on ambiguity).

---

## 12. Scheduling and Execution Contract

- The approved plan's DAG is the scheduler's only input (plus resource availability from the runtime).
- Execution overlay per task: `pending → ready → running → done | failed`; `ready` requires all `dependsOn` done and resources available.
- Executor agents run tasks; each task's `requiredCapabilities` resolve to platform capabilities (tools/commands) at execution time.
- Verification per `Task.verification` and `policy.verificationLevel`.
- The executor never reorders tasks. Reordering requires a replan (new revision + approval if user-visible).

---

## 13. Replanning Rules

Deterministic triggers:

- User requests a change.
- Verification failure (N consecutive failures on the same task, N from policy).
- Strategy change (user edits the policy).
- New information that invalidates an assumption (`confidence` drop or user correction).

Scope — **rewrite the affected subtree only**:

1. Compute the affected set: the failing/changed task plus everything transitively depending on it (reverse closure over the DAG).
2. Re-run Goal Analysis (only if the goal itself changed) → Task Decomposition (affected tasks only) → Dependency Builder → Critic → Optimizer.
3. Unaffected tasks keep their ids, titles, and edges; `revisions` gains a `replan` entry with `changedTaskIds`.
4. Metrics recomputed; approval required before re-execution if the change is user-visible.

Never regenerate the entire plan for a local change.

---

## 14. Quality Metrics

Exposed on the plan and updated at review time:

```ts
const Metrics = Type.Object({
  completeness:    Type.Number({ minimum: 0, maximum: 100 }),
  confidence:      Type.Number({ minimum: 0, maximum: 100 }),
  parallelism:     Type.Number({ minimum: 0, maximum: 100 }),  // DAG-derived
  risk:            Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  unknownCount:    Type.Integer(),
  missingInformation: Type.Array(Type.String()),
});
```

- `parallelism` is **computed** from the DAG (width / critical path) — no LLM involved.
- Completeness, confidence, risk, unknowns are AI-assessed with a small non-mutating prompt.
- Weak areas surface early: low completeness ⇒ run Critic again; high risk ⇒ force approval; many unknowns ⇒ clarification or explicit assumptions.

---

## 15. Assumptions and Open Questions

### Assumptions

- The plan document is small (hundreds of tasks at most) — full re-store per revision is fine.
- Strict JSON per stage costs less than the debugging it saves.
- Execution is single-run per approval by default; resume is a later feature.
- Planning stages run in-process as capabilities (see §16); a distributed planner is out of scope.

### Open questions

- Where does the plan live per scope: session-scoped, project-scoped, or user-scoped storage? (Affects `SessionService` vs a plan store.)
- Approval UX in interactive mode: inline editor vs selector; how to render the DAG for review.
- How much of the execution overlay to persist for resume semantics.
- Metric calibration: what do real scores mean across plan sizes/kinds.
- Whether `dualPlanner` merge conflicts should ever escalate to the user instead of resolving deterministically.

---

## 16. Integration with the Pi Platform

The planning skill is designed as a first-class citizen of the capability platform (Steps 1.2/1.3):

- **Plan object** — a persisted, versioned, schema-validated document (JSON), owned by the runtime, stored via the session/plan store; `schemaVersion` matches the platform's manifest-versioning discipline.
- **Pipeline stages as capabilities** — each AI stage is a small capability (category `orchestration`) with a manifest (`PlanningPolicy`-compatible config), lifecycle from the kernel, and strict JSON exports. Stage isolation = capability error containment.
- **Actions = capability executions** — task `requiredCapabilities` resolve through the `CapabilityRegistry`; the deterministic scheduler maps `ready` tasks to capability invocations.
- **Events** — `plan.created`, `plan.approved`, `plan.replanning`, `plan.completed` flow over the platform `EventBusService` for observability and multi-frontend support.
- **Deterministic scheduler** — kernel-side code (a platform service), never a capability; "scheduling = code, planning = AI" is enforced structurally.
- **No external orchestration framework** — the kernel's registry, lifecycle, events, and service provider already provide everything the pipeline needs.

---

## 17. Summary

The planning skill is: **a persistent structured artifact (Plan), produced by a deterministic-orchestrated pipeline of small, schema-validated AI stages, executed by a deterministic scheduler, and evolved collaboratively with the user.** The two highest-leverage design choices are (1) the first-class **Execution Strategy Selection** stage that makes planning policy explicit and consistent, and (2) **strict per-stage JSON contracts** (TypeBox-validated) that make every stage independently testable — if one degrades after a model update, you know exactly which stage failed.
