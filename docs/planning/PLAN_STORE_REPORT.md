# Planning (ROADMAP Step 2) — Plan Store + Scope + Persistence: Design Report (Step 2.2)

**Status:** Implemented and validated
**Based on:** `docs/planning/PLAN_STORE_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

A `PlanStore` that owns the canonical `Plan` as a project/workspace-scoped,
on-disk-JSON source of truth — the storage every planning stage reads and writes
through. It lives in the platform implementation area (`@earendil-works/pi-platform/kernel`),
next to `NodeFileSystemService` and the other kernel components, and is exposed
via the `/kernel` subpath.

| Component | Location | What it is |
| --- | --- | --- |
| `PlanStore` | `packages/platform/src/kernel/plan-store.ts` (new) | `save` / `load` / `exists` / `list` / `delete` / `revise` over `<root>/plans/<planId>.json` |
| Types | same file | `PlanStoreOptions`, `PlanSummary` |
| Export | `packages/platform/src/kernel/index.ts` | `PlanStore` added to `/kernel` |

Key behaviors:

- **On-disk layout:** one `.json` file per plan under `<root>/plans/` (dir name
  overridable), named by plan id, containing the *full* `Plan` document
  including its embedded `revisions` history. Self-indexing — `list()` is a
  readdir; no separate index file.
- **Read-through, no cache:** every `load`/`list` reads fresh from disk, so an
  external editor edit is picked up at the point of use and drift is impossible
  by construction. File `mtime` is surfaced as `PlanSummary.modifiedAt` for any
  future stat-based detector or `fs.watch` consumer.
- **§8 revision model:** full-document re-store per revision. `revise()` loads
  the freshest doc, runs a `mutate`, appends a `revision` with the next
  `version` and refreshed `updatedAt`, and re-stores — the exact call the 2.4+
  stages and the 2.11 `user_edit` path will use for `critic`/`optimizer`/`replan`
  revisions.
- **Validation + safety:** `save` and `load` validate against `PlanSchema`
  (`ValidationError` on invalid content, `NotFoundError` on a missing file);
  plan ids are checked against a safe filename pattern (no path traversal);
  writes are atomic (temp file + rename).

## 2. The Decisions This Step Made (from the design)

1. **Placement:** implementation, so it lives in the platform `/kernel`
   alongside the other runtime components and is exported as
   `@earendil-works/pi-platform/kernel` — following the Step 1 precedent where
   implementations live in `kernel/` and contract modules stay touch-free.
2. **Layout:** one full-document JSON per plan, self-indexing directory, no
   separate index or revision-history file (history is embedded in the `Plan`).
3. **Read-through with no cache** — the strongest, simplest guarantee against
   drift; stat-based detection is only needed if a cache is ever added, and the
   `modifiedAt` field is exposed for that.
4. **Not wired into the kernel service provider / capability contexts** this
   step — that wiring is the 2.3 stage-contract step's job.

## 3. Validation Results

- `packages/platform/test/plan-store.test.ts` — **13/13 pass** (new):
  - save/load round-trip; one JSON file per plan; custom `plansDirName`; missing
    plan → `NotFoundError`;
  - rejects invalid plan on save (`ValidationError`); rejects invalid on-disk
    content on load; rejects unsafe plan ids (`../evil`, `../../etc/passwd`);
  - read-through: an external overwrite of a plan file is returned by the next
    `load`, and an external new plan file appears in `list` (no drift);
  - `list` returns `PlanSummary` metadata (id/status/version/updatedAt/
    taskCount/modifiedAt) with no full documents; `exists`; `delete` (and
    `NotFoundError` on deleting a missing plan);
  - `revise` appends a revision, re-stores the full doc, bumps `version` on a
    second call, and the revision is visible after a fresh `load`.
- Full `packages/platform` vitest suite — **91/91 pass** (was 78, +13).
- Repo-wide `npm run check` **green**: biome, pinned-deps, ts-imports,
  shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke.
- `dist` not rebuilt: `kernel` is gitignored build output and no consumer
  imports `PlanStore` yet (Step 1.4 precedent).

## 4. Scope Notes

- Step 2.2 was the store only. The stage contract skeleton (2.3), the pipeline
  stages (2.4+), and wiring the store into a service/context are separate later
  steps and were not built.
- The plan store is a standalone implementation; it is not (yet) exposed through
  `KernelServiceProvider` or a capability context — that is 2.3.
- No changelog entry: `packages/platform` has no `CHANGELOG.md` (created in
  Step 1.2; prior contract/step reports added none).

## 5. Recommended Next Step

**Step 2.3 — Planning capability skeleton + stage contract.** The schema (2.1)
now has a real owner (2.2); the natural next step is giving stages a way to
read/write it through the platform. Per `docs/planning/PLANNING_STEPS.md`, 2.3
lands the generic stage contract shape (`systemPrompt` + inputs + `outputSchema`
with strict-JSON exec, one retry, then degrade), per-stage model routing, the
`orchestration`-category manifest/export shape, and the planning event surface
(`plan.created`/`plan.approved`/`plan.replanning`/`plan.completed`) — a walking
skeleton with one trivial stage persisted through the 2.2 store. That is also
where the store gets wired behind a service/context, closing the loop between
the storage and the pipeline.
