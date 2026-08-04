# Planning (ROADMAP Step 2) — Dependency Builder (DAG): Design Report (Step 2.8)

**Status:** Implemented and validated
**Based on:** `docs/planning/DEPENDENCY_BUILDER_DESIGN.md` (this step's design)
**Date:** 2026-02-08

---

## 1. What Was Built

The first deterministic orchestration core (§6.3.5): a `buildDependencyGraph`
that builds the task DAG from the decomposed task set — deterministic edges from
artifact I/O and explicit ordering, a bounded AI fallback for ambiguous artifact
edges, edges folded into `dependsOn`, and always-on acyclicity validation that
reports `circularDependencies` to the Critic instead of throwing.

| Component | Location | What it is |
| --- | --- | --- |
| Dependency Builder | `packages/platform/src/planning/dependency-builder.ts` (new) | `buildDependencyGraph(tasks, options?)` + types |
| Re-export | `packages/platform/src/planning/index.ts` | added to `/planning` |
| Tests | `packages/platform/test/dependency-builder.test.ts` (new) | 8 tests |

Key behaviors:

- **Rule 1 — artifact I/O:** a consumer's `inputs` are matched against every
  producer's `{ deliverable, ...outputs }`. Exactly one producer ⇒ definite
  edge `producer→consumer`; more than one ⇒ ambiguous candidate; zero ⇒
  unresolved candidate.
- **Rule 2 — explicit ordering:** caller-supplied `explicitEdges` (user/constraint
  ordering) are added verbatim; an endpoint that is not a task is ignored.
- **Rule 3 — bounded AI fallback:** `resolveAmbiguous(candidates)` runs only when
  candidates exist and may add edges only among tasked ids. (The 2.1 `Task`
  carries no artifact→capability/skill metadata, so §6.3.5 rules 2/4 are captured
  by this fallback rather than hardcoded.)
- **Fold + acyclicity:** edges fold into `dependsOn` (deduped, sorted); a DFS
  back-edge check detects cycles, canonicalized and deduped, and returns them in
  `circularDependencies` — the builder never throws for a cycle (diagnosis is the
  Critic's job, 2.9); runtime scheduling (2.12) refuses cyclic graphs.

## 2. The Decisions This Step Made (from the design)

1. **Deterministic rules run in order** (artifact I/O, then explicit ordering),
   with the AI fallback bounded to unresolved/ambiguous candidates only.
2. **Acyclicity is always validated**, with cycles returned (not thrown) so the
   Critic consumes them.
3. **The builder consumes the enriched task list** (inputs/outputs populated) —
   what the deterministic rules need; the 2.7 completion emits the full `Task`
   shape, and the 2.12 orchestrator supplies the enriched decomposition.

## 3. Validation Results

- `packages/platform/test/dependency-builder.test.ts` — **8/8 pass** (new):
  - artifact-I/O edge from the sole producer to the consumer (`dependsOn`
    folded);
  - deliverable counts as a produced artifact;
  - explicit ordering edges added verbatim; an edge with an unknown endpoint is
    dropped;
  - ambiguous multi-producer artifacts surfaced as `DependencyCandidate`s and
    resolved by the `resolveAmbiguous` fallback; the fallback is *not* called
    when there are no candidates;
  - a DAG yields empty `circularDependencies` and a full plan with the folded
    tasks validates against `PlanSchema`;
  - a cyclic task set returns the cycle in `circularDependencies` (not thrown).
- Full `packages/platform` vitest suite — **141/141 pass** (was 133, +8).
- Repo-wide `npm run check` **green**: biome, pinned-deps, ts-imports,
  shrinkwrap, install-lock, `tsgo --noEmit`, browser-smoke.
- `dist` not rebuilt: gitignored build output, no consumer yet (Step 1.4 precedent).

## 4. Scope Notes

- Step 2.8 was the Dependency Builder (task DAG). The Plan Critic + Optimizer
  (2.9), which consume `circularDependencies` and refine the plan, and the
  downstream stages are later steps and were not built.
- The §6.3.5 rules 2/4 (capability / skill prerequisites) are captured by the
  bounded AI fallback because the 2.1 `Task` schema has no artifact→capability or
  skill field; if the model later provides such metadata, they can be promoted to
  deterministic rules.
- Full pipeline orchestration and the coding-agent entry point land at 2.12.
- No changelog entry: `packages/platform` has no `CHANGELOG.md` (created in
  Step 1.2; prior planning step reports added none).

## 5. Recommended Next Step

**Step 2.9 — Plan Critic + Optimizer.** Per `docs/planning/PLANNING_STEPS.md`, the
pair consumes the built DAG (`circularDependencies`, missing/duplicate artifacts,
risks) adversarially and refines the draft plan within intent, recording
`critic`/`optimizer` revisions (§8) with `changedTaskIds`. Both are §11 optional
stages (skip rather than abort on repeated failure). That closes the
generate→critique→refine loop on the validated DAG.
