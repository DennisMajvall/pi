# Planning (ROADMAP Step 2) — Plan Object: Canonical TypeBox Schemas (Step 2.1)

**Status:** Design (pre-implementation)
**Based on:** `docs/PLANNING_ARCHITECTURE.md` §4 (canonical Plan schema), §5 (plan content vs execution state), §14 (`Metrics`); `docs/CAPABILITY_PLATFORM_CONTRACTS.md` (the Step 1.2 contract discipline being mirrored); `docs/planning/PLANNING_STEPS.md` Step 2.1
**Package:** `@earendil-works/pi-platform` (contracts already live here; kernel `/kernel` is not touched this step)
**Date:** 2026-02-08

---

## 1. Objective

The Plan object is the artifact every planning stage reads and writes. This
step makes that object canonical: a single, validated, TypeBox schema (`Plan`)
plus the object types it is composed of (`Goal`, `Assumption`, `Constraint`,
`Task`, `PlanningPolicy`, `Revision`, `Metrics`) and the `status` / `revision
reason` enums, packaged to the Step 1.2 contract discipline (types in a
contract module, schemas in the `/schema` module, `schemaVersion` guard, branded
ids where they exist).

Step 2.1 is **schema + round-trip validation only**. The plan store (2.2),
stage contract skeleton (2.3), and pipeline stages (2.4+) are separate later
steps and are deliberately not built here.

## 2. Placement (following Step 1.2 contract discipline)

The Step 1.2 contracts package puts canonical TypeScript types in sibling
contract modules (`/capability`, `/event`, `/error`, `/identifier`) and the
serializable TypeBox schemas as **constants only** in the `/schema` module, with
`Static<typeof XSchema>` derived at the consumer site. One new domain, `plan`,
mirrors that split:

| Artifact | Location |
| --- | --- |
| Canonical types + const objects (`PlanStatus`, `RevisionReason`, `ConstraintKind`, `AssumptionSource`, `TaskKind`, `PlanningDepth`, `VerificationLevel`, `PlanRisk`) | `packages/platform/src/plan/index.ts` (new) |
| TypeBox schemas (constants only) | `packages/platform/src/schema/plan.ts` (new); shared primitives (`CapabilityIdSchema`, `CapabilityVersionSchema`) extracted to `schema/shared.ts` so `plan.ts` reuses them without a circular import |
| Schema registry update | `packages/platform/src/schema/index.ts` `PlatformSchemas` |
| Re-export | `@earendil-works/pi-platform/plan` subpath (package.json). **Not re-exported from the package root** — the root would collide with the pre-existing orchestration `Plan = { steps }` in `./capability/index.ts` (§5 below). |

`PlanId` and `TaskId` already exist as branded identifiers in
`packages/platform/src/identifier/index.ts` — the plan types reuse them rather
than redefining ids; `Dependency` edges and the rest are plain strings in the
document. This keeps the plan a pure serializable document (all types are
JSON-erased strings), matching §4.

No `kernel`/`runtime`/`service` code changes this step. No existing file is
modified (only additions + `package-lock.json` if a new entry is needed — none
is, the package already exists).

## 3. Field set (source: Architecture §4, §14)

The field set below is the **canonical** set. Two fields from the prose are
deliberately NOT carried, per the locked decisions:

### 3.1 The plan content vs execution state split (§5) — enforced in the schema

`Task` carries **no** `status`, `priority`, or `responsibleAgent`. Those live in
the runtime-owned execution overlay (§5, §12) and must never appear in the
persisted/versioned plan. Enforced structurally: the `TaskSchema` has
`additionalProperties: false`, so a stage or store that emits a `status` on a
task fails validation immediately.

### 3.2 `maxClarificationRounds`

Architecture §9 references a `policy.maxClarificationRounds` (default 2), but
the canonical §4 `PlanningPolicy` sketch omits it, and the task directive is to
use §4/§14 as the source. **Not added to `PlanningPolicy` this step.** The
Clarification Gate step (2.4) owns the bound; if it needs to be configurable per
plan it becomes a policy field then. Kept out now to stay faithful to the
canonical sketch.

### 3.3 The full type list

**`Goal`**
- `summary: string`
- `successCriteria: string[]`
- `unknowns: string[]`
- `requiresClarification: boolean`
- `clarificationQuestions: ClarificationQuestion[]`
- `ClarificationQuestion = { question: string; blocking: boolean }` — the §4
  sketch references `ClarificationQuestion` without defining it; minimal shape,
  `blocking` marks the high-priority unknowns the Clarification Gate (§9) pauses
  on.

**`Assumption`**
- `statement: string`
- `confidence: number` (0–100)
- `source: "user" | "verified" | "inferred"` (`AssumptionSource`)

**`Constraint`**
- `kind: "hard" | "soft" | "resource" | "policy"` (`ConstraintKind`)
- `description: string`
- The four §6.3.3 input buckets fold into this stored form; the plan persists
  only the folded `kind`+`description`.

**`Task`** (no execution fields — §5)
- `id: TaskId`
- `title: string`
- `purpose: string`
- `deliverable: string`
- `inputs: string[]`
- `outputs: string[]`
- `dependsOn: TaskId[]`
- `requiredCapabilities: CapabilityId[]` — platform capability ids only,
  validated against `CapabilityIdSchema` (no free-text skill names)
- `verification: string`

**`PlanningPolicy`**
- `taskKind: "research" | "implementation" | "debugging" | "design" | "maintenance" | "mixed"`
- `planningDepth: "low" | "medium" | "high"`
- `hierarchicalRefinement: boolean`
- `parallelExecution: boolean`
- `specialistAgents: boolean`
- `requireApproval: boolean`
- `verificationLevel: "none" | "basic" | "strict"`
- `preferResearch: boolean`
- `maxTasks: integer` (≥ 1)
- `dualPlanner: boolean`

**`Revision`**
- `version: integer` (≥ 1)
- `reason: "user_edit" | "critic" | "optimizer" | "replan" | "approval"`
  (`RevisionReason`)
- `changedTaskIds: TaskId[]`
- `createdAt: number` (Unix ms)

**`Plan`**
- `id: PlanId`
- `schemaVersion: 1` (Literal — guards evolution)
- `goal: Goal`
- `policy: PlanningPolicy`
- `constraints: Constraint[]`
- `assumptions: Assumption[]`
- `tasks: Task[]`
- `revisions: Revision[]`
- `status: "draft" | "needs_review" | "approved" | "running" | "replanning" |
  "completed" | "failed" | "archived"` (`PlanStatus`)
- `metrics?: Metrics` (optional; set at review time, §14)
- `createdAt: number`
- `updatedAt: number`

**`Metrics`** (§14)
- `completeness: number` (0–100)
- `confidence: number` (0–100)
- `parallelism: number` (0–100) — DAG-derived, but the schema only constrains the
  range (computation is 2.8/2.10)
- `risk: "low" | "medium" | "high"` (`PlanRisk`)
- `unknownCount: integer` (≥ 0)
- `missingInformation: string[]`

### 3.4 Range/numeric invariants

Confidence/completeness/parallelism are `minimum: 0, maximum: 100`.
`maxTasks` ≥ 1, `Revision.version` ≥ 1, `unknownCount` ≥ 0 — all integers where
the architecture says integer. These are encoded directly in the schemas so
validation rejects out-of-range stage output.

## 4. Decisions summarized

1. **Package/placement:** contracts already live in `@earendil-works/pi-platform`; the
   plan domain follows the Step 1.2 type-in-contract-module /
   schema-constants-in-`/schema` split, with a `plan` subpath.
2. **`Task` carries no execution state** — enforced with
   `additionalProperties: false` on `TaskSchema` (the §5 split is a schema
   invariant, not just documentation).
3. **`requiredCapabilities` is `CapabilityId`-typed** and validated via
   `CapabilityIdSchema`, rejecting free-text skill names per §4.
4. **`maxClarificationRounds` deferred** to the Clarification Gate step (2.4),
   per §9-vs-§4 ambiguity resolved toward the canonical §4 sketch.

## 5. Root-export collision (the `Plan` name)

There is a pre-existing `Plan` interface in `./capability/index.ts` — the
orchestration step-plan `{ steps: PlanStep[] }` used by
`OrchestrationCapabilityExport.execute`. The planning `Plan` object is a
different, canonical concept (Architecture §4) and keeps that name. Re-exporting
both from the package root would create an ambiguous duplicate export, so the
planning domain is exposed only via the `@earendil-works/pi-platform/plan`
subpath (and its `PlanSchema` via `/schema`, which has no collision). The
pre-existing orchestration `Plan` contract is untouched. This is a deliberate
API-surface decision for 2.1, documented so a future consumer imports from the
`/plan` subpath.

## 6. Validation performed (this step)

- `packages/platform/test/plan.test.ts` (new, 14 tests): a canonical plan fixture
  round-trips through `Value.Check(PlanSchema, ...)` and JSON; positive cases
  cover every `status` and `revision reason` value and optional `metrics`;
  negative cases prove the §5 split (a task with `status`/`priority`/
  `responsibleAgent`/unknown fields fails), schemaVersion ≠ 1 rejection, unknown
  enum rejection, non-capability-id `requiredCapabilities` rejection, and a
  malformed clarification question.
- Full `packages/platform` vitest suite: 78/78 pass (was 64, +14).
- Repo-wide `npm run check` green (biome, pinned-deps, ts-imports, shrinkwrap,
  install-lock, `tsgo --noEmit`, browser-smoke).
- No `dist` rebuild: contracts-only, no consumer imports the plan domain yet,
  and `dist` is gitignored (Step 1.4 precedent).
