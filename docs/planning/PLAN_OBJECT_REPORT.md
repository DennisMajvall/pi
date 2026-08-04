# Planning (ROADMAP Step 2) — Plan Object: Canonical TypeBox Schemas: Design Report (Step 2.1)

**Status:** Implemented and validated
**Based on:** `docs/planning/PLAN_OBJECT_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

The canonical Plan object as a pure contracts deliverable in
`@earendil-works/pi-platform`, following the Step 1.2 contract discipline. The
planning domain now has one validated `PlanSchema` composed of `Goal`,
`Assumption`, `Constraint`, `Task`, `PlanningPolicy`, `Revision`, and `Metrics`
schemas, plus the `status` and `revision reason` value sets — the single schema
every planning stage will read and write against.

| Component | Location | What it is |
| --- | --- | --- |
| Plan contracts (types + const objects) | `packages/platform/src/plan/index.ts` (new) | Canonical interfaces `Plan`/`Goal`/`Assumption`/`Constraint`/`Task`/`PlanningPolicy`/`Revision`/`Metrics`/`ClarificationQuestion`; const objects `PlanStatus`, `RevisionReason`, `TaskKind`, `PlanningDepth`, `VerificationLevel`, `AssumptionSource`, `ConstraintKind`, `PlanRisk` |
| Plan schemas (constants) | `packages/platform/src/schema/plan.ts` (new) | `PlanSchema` + the composed schemas; `additionalProperties: false` throughout |
| Shared primitives | `packages/platform/src/schema/shared.ts` (new) | `CapabilityIdSchema`/`CapabilityVersionSchema` extracted from `schema/index.ts` so `plan.ts` reuses the capability-id schema without a circular import |
| Schema registry | `packages/platform/src/schema/index.ts` | Re-exports `./plan.ts` (no name collision on `PlanSchema`) and registers `PlatformSchemas.Plan` |
| Subpath export | `packages/platform/package.json` | `@earendil-works/pi-platform/plan` |
| Tests | `packages/platform/test/plan.test.ts` (new) | 14 round-trip + invariant tests |

No kernel/runtime/service code changed. No existing source file was modified
(only additions, plus the `schema/index.ts` extraction of two shared primitives
that have no external consumers).

## 2. The Decisions This Step Made

1. **Placement (Step 1.2 discipline).** Types live in a contract module
   (`/plan`), schemas are constants in `/schema`, `schemaVersion` guards
   evolution, and the plan reuses the existing branded `PlanId`/`TaskId`
   identifiers rather than redefining them.

2. **The §5 execution-state split is a schema invariant.** `TaskSchema` has
   `additionalProperties: false`, so any `status`/`priority`/`responsibleAgent`
   (or any stray field) on a task fails validation. This is enforced structurally,
   not just documented — a stage or store cannot silently contaminate plan
   content with execution state.

3. **`requiredCapabilities` is capability-id-validated.** Each element is checked
   against `CapabilityIdSchema`, so only platform capability ids (`tool.read`,
   `command.bash`) are accepted and free-text skill names are rejected — per §4.

4. **`maxClarificationRounds` deferred.** §9 references a `policy.maxClarificationRounds`
   that the canonical §4 `PlanningPolicy` sketch omits. Per the directive to use
   §4/§14 as the source, it is not added to `PlanningPolicy`; the Clarification
   Gate step (2.4) owns that bound and can promote it to a policy field then.

5. **Root-export collision (the `Plan` name) resolved toward non-breaking.** A
   pre-existing orchestration `Plan = { steps }` in `./capability/index.ts`
   (used by `OrchestrationCapabilityExport.execute`) already owns the name.
   Rather than break that contract or rename the canonical planning `Plan`, the
   planning domain is exported only via the `/plan` subpath (with `PlanSchema`
   surfaced through `/schema`). A future consumer imports from
   `@earendil-works/pi-platform/plan`. The orchestration `Plan` is untouched.

## 3. Validation Results

- `packages/platform/test/plan.test.ts` — **14/14 pass** (new):
  - canonical plan validates and round-trips through `JSON.parse(JSON.stringify)`; `metrics` optional when removed;
  - every `status` (8) and `revision reason` (5) value accepted; unknown `status`,
    unknown revision `reason`, and `schemaVersion: 2` all rejected;
  - §5 split: a task carrying `status`/`priority`/`responsibleAgent`, or any extra
    field, fails `TaskSchema`;
  - `requiredCapabilities` rejects `"write files"` and bare `"read"`, accepts
    `tool.read`/`command.bash`;
  - a `clarificationQuestion` missing `blocking` fails `GoalSchema`;
  - `TaskSchema` validates the fixture alone.
- Full `packages/platform` vitest suite — **78/78 pass** (was 64, +14).
- Repo-wide `npm run check` **green**: biome, pinned-deps, ts-imports,
  shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke.
- `dist` not rebuilt: contracts-only, no consumer imports the plan domain yet,
  and `dist` is gitignored (Step 1.4 precedent).

## 4. Scope Notes

- Step 2.1 was schema + round-trip validation only. The plan store (2.2) and the
  stage contract skeleton (2.3) are separate later steps and were not built.
- No changelog entry: `packages/platform` has no `CHANGELOG.md` (created in
  Step 1.2, and the prior contract-only steps added none), so none was added.

## 5. Recommended Next Step

**Step 2.2 — Plan store + scope + persistence.** The schema now has a canonical,
validated shape; the natural next step is giving it a real owner. Per
`docs/planning/PLANNING_STEPS.md`, 2.2 lands the project/workspace-scoped,
on-disk-JSON plan store with read-through change detection and the
per-revision history (`revisions`), validating against `PlanSchema` on load and
save. That validates the schema against a real write/read path before any
pipeline stage consumes it (2.3+).
