# Planning (ROADMAP Step 2) — TUI Plan View: Design (Step 2.13)

**Status:** Design (pre-implementation)
**Based on:** `docs/PLANNING_ARCHITECTURE.md` §6.3.10 (human gate), §15 (approval UX),
§16 (plans are capability-owned persisted docs); `docs/planning/PLANNING_STEPS.md`
Step 2.13; `docs/planning/PLAN_SCHEDULER_E2E_REPORT.md` (2.12 recommended next
step = 2.13); `packages/coding-agent/docs/tui.md` + `extensions.md` (how pi's TUI is
extended: extensions + `ctx.ui.custom`).
**Packages:** `@earendil-works/pi-platform` (`/planning` subpath) + `packages/coding-agent`
(the product TUI host).
**Date:** 2026-02-15

---

## 1. Objective

Give the user a dedicated TUI surface for reviewing, editing, and approving plans —
closing the Planning-complete review loop in the running agent. The surface is the
idiomatic pi extension path (a command rendering a custom pi-tui component via
`ctx.ui.custom`), built on top of the fully-tested platform core (2.11 gate +
`user_edit` + renderer; 2.12 scheduler/orchestrator; 2.13.1 runner; 2.13.2 widget).

Deliverable: a plan view that **lists plans**, **drills into a selected plan** (DAG +
selectable task list with a detail pane), accepts **prompt-driven `user_edit`**
directives, and **collects approvals** — Esc returns to chat.

## 2. Placement

| Substep | Artifact | Location |
| --- | --- | --- |
| 2.13.1 | `PlanCapabilityRunner` + `PlanListEntry` view model | `packages/platform/src/planning/plan-capability.ts` (new) |
| 2.13.2 | `PlanViewWidget` (headless controller) + `renderTaskDetail` | `packages/platform/src/planning/plan-view-widget.ts` (new) |
| 2.13.3 | `PlanViewComponent` (pi-tui adapter) + `/plans` extension | `packages/coding-agent/src/extensions/plan/` (new) |
| 2.13.4 | root `tsconfig` source path-map for `pi-platform` | `tsconfig.json` |

The view reuses the 2.11 renderers (`renderPlanView`/`renderPlanDag`/`renderTaskList`)
and capability logic (gate + `user_edit`) through the runner; only the thin terminal
adapter + command are coding-agent code.

## 3. Decisions

1. **A pi-tui component + a `/plans` extension command, exactly how public extensions
   modify the TUI.** `pi.registerCommand("plans")` → `ctx.ui.custom((tui, theme,
   keybindings, done) => new PlanViewComponent(...))`. This is the marketed, documented
   customization path (extensions.md/tui.md) with an in-repo precedent (the llama
   extension's `ctx.ui.custom` dialog).
2. **The interactive logic is a headless controller (`PlanViewWidget`), tested with
   semantic actions + `render(width)`, and the pi-tui adapter is deliberately tiny** —
   it maps raw terminal key bytes to semantic actions and calls `tui.requestRender()`.
   This keeps the whole flow testable without a terminal or model, and keeps the
   terminal coupling minimal.
3. **The runner operates on the workspace plan store (read-through)** rooted at
   `<workspace>/plans`; every render/navigation/action re-reads from disk (no cache) +
   a manual `r` refresh. `fs.watch`/event replay stays out (roadmap #4).
4. **Approval is explicit** (`a` approve hint in the detail view when the gate applies),
   driving `orchestration.plan.review` (`plan.approved` on the bus). Edit directives
   route through `parsePlanEdit`/`user_edit` (schema-preserving; cycle-rejecting edits
   surface an inline error).
5. **No dist/build coupling.** The platform already exports `./planning`; `packages/coding-agent`
   resolves it from **source** via the root `tsconfig.json` path-map (the same way every
   other workspace package resolves) plus the existing vitest `resolve.alias`. So it
   works before/after rebuilds with no dependence on build artifacts.
6. **Real-model `/plan <request>` pipeline + complexity auto-trigger remain deferred.**
   Step 2.13 is the *review surface* for plans that exist on disk; binding the planning
   AI stages to a real model (and the auto-engage trigger) is the host wiring deferred
   since Steps 2.3–2.12 and is a documented follow-up, orthogonal to this deliverable.

## 4. Navigation & keys

- **List screen:** `up`/`down` move selection; `enter` opens the selected plan;
  `esc` quits to chat; `r` re-reads.
- **Detail screen:** `up`/`down` move the task selection (detail pane updates to the
  selected task's purpose/deliverable/deps/verification); `a` approves (visible hint
  when the plan is ask-for-approval); `e` begins an edit; `esc` returns to the list.
- **Editing screen:** printable characters append to the directive buffer (mode-aware,
  so `a`/`e`/`r` type rather than act); `enter` submits; `esc` cancels back to detail.
- **On-disk editing stays available** (the plan JSON is the editable source of truth;
  `r` on the list re-reads, and opening a plan re-reads it).

## 5. Test plan

- `packages/platform/test/plan-capability.test.ts` (2.13.1): list/load read-through,
  review honors the gate + emits `plan.approved`, edit is schema-preserving.
- `packages/platform/test/plan-view-widget.test.ts` (2.13.2): headless flow — list →
  drill-in → task detail → approve → edit (incl. rejected-cycle error) → escape-back;
  read-through freshness + manual refresh.
- `packages/coding-agent/test/plan-view-component.test.ts` (2.13.3): the pi-tui adapter
  driven by raw key bytes (`\x1bOA`/`\x1bOB`/`\r`/`\x1b`/letters) against a temp-dir
  store — arrow nav, enter drill, `a` approve (re-render), `e` + typed directive +
  enter submit, escape-back twice to chat.
- Full platform suite + repo `npm run check` green.
