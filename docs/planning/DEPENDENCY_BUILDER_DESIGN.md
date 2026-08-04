# Planning (ROADMAP Step 2) — Dependency Builder (DAG): Design (Step 2.8)

**Status:** Design (pre-implementation)
**Based on:** `docs/PLANNING_ARCHITECTURE.md` §6.3.5 (stage 5, deterministic rules + bounded AI fallback + acyclicity), §4 (edges folded into `dependsOn`); `docs/planning/PLANNING_STEPS.md` Step 2.8; `docs/planning/TASK_DECOMPOSITION_REPORT.md` (Step 2.7 recommended next step)
**Package:** `@earendil-works/pi-platform` (`/planning` subpath)
**Date:** 2026-02-08

---

## 1. Objective

The first deterministic orchestration core (§6.3.5): build the task **DAG** from
the decomposed task set — derive dependency edges deterministically, fold them
into each task's `dependsOn`, validate **acyclicity**, and report any
`circularDependencies` to the Plan Critic (2.9) rather than ever scheduling a
cyclic graph.

## 2. Placement

Implementation in the `/planning` subpath, reusing the 2.1 `Task` / task ids and
the 2.7 completed-task shape:

| Artifact | Location |
| --- | --- |
| Dependency Builder | `packages/platform/src/planning/dependency-builder.ts` (new) |
| Re-export | `packages/platform/src/planning/index.ts` |
| Tests | `packages/platform/test/dependency-builder.test.ts` (new) |

No contract module changes.

## 3. The dependency rules (§6.3.5)

`buildDependencyGraph(tasks, options?) → Promise<DependencyBuildResult>` runs the
deterministic rules **in order** and folds each edge into `dependsOn` (`edge `
`{from, to}` ⇒ `tasks[to].dependsOn` includes `from`; `from` must run first):

1. **Artifact I/O** — for each consumer task `c`, each `c.inputs` artifact is
   matched against every producer's `produced = { deliverable, ...outputs }`.
   - exactly one producer matches ⇒ definite edge `producer→c`;
   - more than one matches ⇒ **ambiguous candidate** (bounded AI fallback);
   - zero matches ⇒ **unresolved** (likely an external artifact; candidate too).
2. **Explicit ordering** — caller-supplied `explicitEdges` (from user/constraint
   ordering, e.g. "deployment after testing") are added verbatim (an undefined
   endpoint is ignored).
3. **Capability/skill prerequisites (rules 2/4)** — the 2.1 `Task` carries no
   artifact→capability or skill metadata, so these are captured by the **bounded
   AI fallback** rather than hardcoded: `resolveAmbiguous(candidates)` is injected
   (host provides it at 2.12; default none) and, when ambiguity exists, returns
   additional `[{from, to}]` edges. It is bounded — it runs only on unresolved/
   ambiguous candidates and may add edges only among the tasked ids.

Because the 2.7 completion emits empty `inputs`/`outputs`/`requiredCapabilities`,
the builder consumes the **enriched** task list (inputs/outputs populated), which
is what the deterministic rules need; the 2.12 orchestrator supplies it.

## 4. Acyclicity (§6.3.5, always)

After folding, the builder runs a deterministic topological check (DFS
back-edge detection) and returns the detected cycles in
`DependencyBuildResult.circularDependencies`. A cycle is reported to the Critic;
the builder never throws for a cycle — it hands the cycles back so the pipeline
can diagnose. Runtime scheduling (2.12) refuses cyclic graphs.

## 5. Public API

```ts
interface DependencyEdge { from: string; to: string }   // from runs before to
interface DependencyBuildOptions {
  explicitEdges?: DependencyEdge[];
  resolveAmbiguous?: (candidates: DependencyCandidate[]) => Promise<DependencyEdge[]>;
}
interface DependencyCandidate { producerIds: string[]; consumerId: string; artifact: string }
interface DependencyBuildResult {
  tasks: Task[];                 // dependsOn folded
  edges: DependencyEdge[];
  circularDependencies: string[][];
}
buildDependencyGraph(tasks: Task[], options?: DependencyBuildOptions): Promise<DependencyBuildResult>;
```

## 6. Validation performed (this step)

- `packages/platform/test/dependency-builder.test.ts` (new):
  - rule 1 folds artifact-I/O edges into `dependsOn` (single proudcer);
  - `explicitEdges` add ordering edges verbatim;
  - multiple producers of the same artifact surface as ambiguous candidates and,
    with a `resolveAmbiguous` fallback, resolve to chosen edges;
  - an acyclic plan comes back with empty `circularDependencies` and a valid
    `dependsOn` (full `Plan` validates against `PlanSchema`);
  - a cyclic task set returns the cycle in `circularDependencies` (not thrown).
- Full `packages/platform` vitest suite + repo-wide `npm run check` green.
