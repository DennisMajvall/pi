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

## The roadmap (build order)

- [x] 1. Capability Platform (#1)
- [ ] 2. Planning (#2) — designed (`docs/PLANNING_ARCHITECTURE.md`)
- [ ] 3. Workspaces / Git Worktrees (#3) — designed (`docs/WORKSPACE_ARCHITECTURE.md`)
- [ ] 4. Event System (#5) — designed (`docs/EVENT_ARCHITECTURE.md`)
- [ ] 5. Background Workers (#6)
- [ ] 6. **Memory (#4)** — designed (`docs/KNOWLEDGE_MEMORY_ARCHITECTURE.md`) — the goal
- [ ] 7. Task / Execution Engine (#7)
- [ ] 8. Subagents (#8)
- [ ] 9. Context Assembly (#10)
- [ ] 10. Workspace Indexing (#9)
- [ ] 11. Approval Framework (#11)
- [ ] 12. Observability (#12)
- [ ] 13. Capability Marketplace (#13)
- [ ] 14. Policies / Rules (#14)
- [ ] 15. Reflection (#15)
- [ ] 16. Knowledge Management (#16)
- [ ] 17. Automation / Triggers (#17)
- [ ] 18. Multi-Agent Collaboration (#18)

## Notes

- Current position: Step 1.10 (the gate) is complete — **Capability Platform
  (ROADMAP item 1) is done**. `_buildRuntime` consumes the platform tool set
  atomically (all seven builtin tools or none): the platform is the default
  execution path, legacy is the explicit wholesale fallback with a loud
  warning, and no mixed platform/legacy session state is possible. The
  seven `buildXToolDefinition` adapters collapsed into one generic builder
  driven by a per-tool spec table, and the manifests' `provides.tool` prose
  is sourced from the tool templates (a fixture pins manifest↔tool equality).
  Next: Planning (`docs/PLANNING_ARCHITECTURE.md`), starting with the Plan
  object.
- Step cadence: one capability or service per step. Every step's report ends
  with a "Recommended Next Step" section that picks the next cheapest
  validation, grounded in the design docs — this is how steps 1.3–1.10 were
  chosen (each report named the next one in advance), not improvised.
- Sub-steps between features are not pre-planned; they are decided when a
  feature starts (the platform steps 1.7–1.10 above are the current view and
  will change as we go).
- "Capability Platform complete" is the gate at which the platform stops being
  an optional layer with a silent fallback and becomes the default execution
  path for the builtin tools. That gate closed at Step 1.10: the builtin tool
  set is sourced atomically from the capability registry (all seven or none),
  legacy is the explicit wholesale fallback, and the adapters + manifest
  prose are deduplicated/pinned.
