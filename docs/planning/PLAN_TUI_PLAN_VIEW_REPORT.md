# Planning (ROADMAP Step 2) — TUI Plan View: Design Report (Step 2.13)

**Status:** Implemented and validated
**Based on:** `docs/planning/PLAN_TUI_PLAN_VIEW_DESIGN.md` (this step's design)
**Date:** 2026-02-15

---

## 1. What Was Built

The dedicated TUI plan review surface, delivered as a `packages/coding-agent`
extension (`/plans`) rendering a pi-tui component via `ctx.ui.custom` — the idiomatic,
documented way pi's TUI is extended (the same path public extensions and the built-in
llama dialog use). It sits on the fully-tested platform core: a `PlanCapabilityRunner`
(2.13.1) drives a headless `PlanViewWidget` controller (2.13.2), and a thin
`PlanViewComponent` terminal adapter (2.13.3) maps keys → actions.

| Substep | Component | Location | Tests |
| --- | --- | --- | --- |
| 2.13.1 | `PlanCapabilityRunner` + `planListEntry` | `packages/platform/src/planning/plan-capability.ts` (new) | `test/plan-capability.test.ts` (7) |
| 2.13.2 | `PlanViewWidget` + `renderTaskDetail` | `packages/platform/src/planning/plan-view-widget.ts` (new) | `test/plan-view-widget.test.ts` (11) |
| 2.13.3 | `PlanViewComponent` + `/plans` extension + root `tsconfig` source path-map | `packages/coding-agent/src/extensions/plan/` (new), `tsconfig.json` | `test/plan-view-component.test.ts` (6) |

Behaviors:

- **List** persisted plans (`<workspace>/plans`) read-through with title/status/version/
  task-count/metrics; `up/down` + `enter` navigate; `esc` returns to chat; `r` re-reads.
- **Drill-in** shows the requirement, a selectable task list alongside the selected
  task's detail (purpose/deliverable/depends-on/requires/verification), and the indented
  DAG (via the 2.11 `renderPlanDag`).
- **Prompt-driven `user_edit`**: `e` opens a directive line; typed directives
  ("merge t2 and t3", "rename t1 to X") route through `parsePlanEdit`/`user_edit`
  (schema-preserving; a cycle-rejecting edit surfaces an inline error and leaves the
  plan unchanged). Mode-aware keys — in the edit line `a`/`e`/`r` type, not act.
- **Approval**: `a` approves a plan ask-ing for it, flipping `needs_review → approved`
  via `reviewGateStage` (`plan.approved` on the bus), re-rendered immediately.
- **Freshness**: every action re-reads from disk; manual refresh supported.
- **No dist/build coupling**: the platform already exports `./planning`, and
  `packages/coding-agent` resolves it from source via the root `tsconfig` path-map
  (matching every other workspace package) + the existing vitest alias.

## 2. The Decisions This Step Made (from the design)

1. Only the terminal adapter + `/plans` command are coding-agent code; the interactive
   logic is a headless, semantic-action controller (`PlanViewWidget`) so the whole flow
   is testable without a terminal or model.
2. The runner operates on the workspace plan store (read-through); the view re-reads on
   every render/navigation/action with a manual `r` refresh (no change-watching — #4).
3. Approval is explicit (`a` in the detail view) driving the 2.11 review gate; edits
   route through the schema-preserving `user_edit` path.
4. Real-model `/plan <request>` pipeline + complexity auto-trigger stay deferred (host
   wiring never designed across 2.3–2.12); 2.13 is the review surface for on-disk plans.

## 3. Validation Results

- `packages/platform/test/plan-capability.test.ts` — **7/7**.
- `packages/platform/test/plan-view-widget.test.ts` — **11/11** (incl. the rejected-
  cycle error path and read-through freshness).
- `packages/coding-agent/test/plan-view-component.test.ts` — **6/6** (raw-key-driven
  adapter: nav, drill, approve re-render, edit submit, escape-back).
- Full `packages/platform` vitest suite — **235 passed + 1 opt-in free-model e2e**
  (skipped without `OPENROUTER_API_KEY`; the free-tier e2e is known-flaky and unrelated
  to this step).
- Repo-wide `npm run check` — **green** (exit 0), including the `tsconfig` path-map
  change that resolves `@earendil-works/pi-platform/planning` from source.

## 4. Scope Notes

- This is the review *surface* (list, DAG/task view, prompt-driven edit, approval).
  Creating new plans live via a real-model `/plan <request>` pipeline and the complexity
  auto-trigger are the remaining host wiring (deferred since Steps 2.3–2.12, not designed
  at the host). The on-disk JSON remains editable source of truth in any editor.
- A dedicated keybinding to open the plan list (beyond the `/plans` command) is optional
  polish; not added to keep the surface minimal.
- No changelog entry: `packages/platform` has no `CHANGELOG.md` (Step 1.2 precedent).

## 5. Recommended Next Step

Re-open the **Planning-complete gate** (2.12) with the TUI surface in place — it now
holds: request → pipeline → approved plan (validated, metric-scored, on-disk,
reviewable, editable, approvable in the `/plans` TUI) → minimal scheduler resolves a
ready task. Then roadmap **#3 (Workspaces)** or, if execution depth is wanted first,
a lean-slice handoff to **#7 (Task/Execution Engine)**. The real-model `/plan` pipeline
+ complexity trigger remain a tracked host-wiring follow-up before autonomous planning
can create plans on demand.
