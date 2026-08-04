# Planning (ROADMAP Step 2) — Plan Store + Scope + Persistence: Design (Step 2.2)

**Status:** Design (pre-implementation)
**Based on:** `docs/PLANNING_ARCHITECTURE.md` §8 (versioning), §15 (where the plan lives), §16 (plan owned via a plan store); `docs/planning/PLANNING_STEPS.md` Step 2.2; `docs/planning/PLAN_OBJECT_REPORT.md` (Step 2.1 recommended next step); `docs/CAPABILITY_PLATFORM_CONTRACTS.md` and the Step 1 kernel precedents (`packages/platform/src/kernel/`)
**Package:** `@earendil-works/pi-platform` (`/kernel` subpath)
**Date:** 2026-02-08

---

## 1. Objective

Give the canonical `Plan` (Step 2.1) a real owner: a project/workspace-scoped
plan store whose on-disk JSON is the durable source of truth, that always serves
the freshest on-disk content (read-through, so external editor edits never
drift), and that retains revision history via the full-document re-store rule of
Architecture §8. This is the storage backbone every planning stage (2.3+) will
read and write through.

Step 2.2 is the store only. The stage contract skeleton (2.3), the pipeline
stages (2.4+), and any wiring of the store into the kernel service provider /
capability contexts are separate later steps and are not built here.

## 2. Placement

The plan store has real runtime behavior (file I/O, validation), so it is
implementation, not a contract. It lives with the rest of the platform
implementation in `packages/platform/src/kernel/` — the same place as
`NodeFileSystemService`, `KernelEventBus`, `NodeProcessService` — exported via
the `/kernel` subpath:

| Artifact | Location |
| --- | --- |
| `PlanStore` (+ `PlanStoreOptions`, `PlanSummary`) | `packages/platform/src/kernel/plan-store.ts` (new) |
| Export | `packages/platform/src/kernel/index.ts` → `@earendil-works/pi-platform/kernel` |

It is **not** wired into `KernelServiceProvider` or any capability context this
step: the store is a standalone class. Wiring it behind a service/context so
stages can reach it is the 2.3 stage-contract step's job. No contract module
(`/plan`, `/schema`) changes. No existing file modified except one export line
in the kernel index.

## 3. Decisions

### 3.1 On-disk layout — one JSON file per plan, self-indexing directory

```
<workspace>
└── plans/                  (plansDirName default "plans", overridable)
    ├── <planId>.json       full Plan document incl. embedded `revisions`
    └── ...
```

Each plan is one `.json` file named by plan id. The *full* `Plan` document —
including its embedded `revisions` history (§4/§8) — is stored per file, so the
directory is self-indexing: `list()` is a readdir over `.json` files, no
separate index file is kept. Plan ids are validated against a safe filename
pattern (`^[A-Za-z0-9][A-Za-z0-9._-]*$`) before any path is built, so a caller
cannot reach outside the plans directory.

### 3.2 Read-through — no cache, so external edits never drift

The store holds **no in-memory plan state**. Every `load`/`list` reads straight
from disk at the point of use, so an editor that edits the JSON directly is
picked up on the next read. This makes drift impossible by construction — there
is no stale copy to diverge. Because there is no cache, no stat-based
invalidation is required; the file `mtime` is still surfaced (as
`PlanSummary.modifiedAt`) so a consumer that *does* add a cache later can use
stat-based change detection, and `fs.watch` plugs in cleanly once the Event
System (roadmap #4) lands.

### 3.3 Revision model — full-document re-store per revision (§8)

Plans are small; each revision is a full re-store of the whole document. The
`revisions` array is already part of the `Plan` schema, so history is embedded
in the file — no separate revision-history file is kept; "revision history
query" = `load().revisions`. `PlanStore.revise(planId, reason, changedTaskIds,
mutate)` encodes the §8 rule: load the freshest doc, run `mutate`, append a
`revision` with the next `version` and a refreshed `updatedAt`, then re-store.
This is what 2.11's `user_edit` and the 2.4+ stages will call to record
`critic`/`optimizer`/`replan` revisions.

### 3.4 Validation on write and read

- `save` validates against `PlanSchema` and rejects non-canonical plans with a
  `ValidationError` (never persists invalid content).
- `load` parses and validates the on-disk content; a file that fails (external
  edit broke the contract) fails loudly with a `ValidationError`, and a missing
  file is a `NotFoundError`. Corrupt/unparseable files surface on `load` (and
  are skipped by `list`, which returns only valid plans).
- Writes are atomic: temp file + rename, so a crash never leaves a partial
  document.

## 4. Public API

```ts
class PlanStore {
  constructor(options: { rootDir: string; plansDirName?: string })
  readonly plansDirPath: string;
  save(plan: Plan): Promise<void>          // validate + atomic write
  load(planId: string): Promise<Plan>      // fresh read-through
  exists(planId: string): Promise<boolean>
  list(): Promise<PlanSummary[]>           // metadata, no full documents
  delete(planId: string): Promise<void>
  revise(planId, reason, changedTaskIds, mutate): Promise<Plan>  // §8 re-store
}

interface PlanSummary { id, status, version, updatedAt, modifiedAt, taskCount }
```

## 5. Validation performed (this step)

- `packages/platform/test/plan-store.test.ts` (new): save/load round-trip,
  per-file layout + custom dir name, read-through (external overwrite is
  reflected on next `load`; external new file appears in `list`), `list`
  summaries, `exists`/`delete`, `revise` revision re-store with version bumps,
  and rejection of invalid-on-save / invalid-on-disk / unsafe ids.
- Full `packages/platform` vitest suite + repo-wide `npm run check` green.
