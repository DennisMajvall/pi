# Runtime Model, Concurrency Axes & Per-Session Runtime Scoping (M1)

**Status:** Architecture scope note (cross-cutting; independent of any single feature).
**Related:** `docs/ROADMAP.md`, `docs/WORKSPACE_ARCHITECTURE.md` §12, `docs/EVENT_ARCHITECTURE.md`,
`docs/PLANNING_ARCHITECTURE.md`, `docs/KNOWLEDGE_MEMORY_ARCHITECTURE.md`,
`docs/CAPABILITY_PLATFORM_STEP1_LEFTOVERS.md` (M1 / M24).

This is the home for two cross-cutting architectural decisions that span several roadmap
steps:

1. **The runtime model** — how many kernels run per process and how services are scoped
   (the current single-kernel model, and its three "parallelism/concurrency" axes).
2. **M1 (Axis A) — per-session runtime scoping**, a deferred human decision gate.

Neither belongs in the roadmap overview nor inside any single feature's design doc; the
roadmap and the feature docs reference this document instead.

---

## Assumed runtime model (single kernel per process)

The platform assumes the **current single-kernel-per-process runtime**: one
`KernelRuntime` and one `ServiceProvider` per process, boot-bound at
`ensurePlatformRuntime`. All current and planned features run on that one kernel. A
session can own many tasks, each executing in its own filesystem isolate (Workspace), all
served by that one kernel — a Workspace's `root` replaces the per-execution **cwd**
(`ToolExecutionContext.cwd`), not the service binding.

## Three distinct "parallelism/concurrency" axes (do not conflate)

The docs use "parallel/concurrent" loosely. There are three different axes, and confusing
them is how conflicting features or a deeper architectural hole arise.

- **Axis A — Runtime scoping (kernel/process/service model).** How many kernels run per
  process, and whether each service is *process-scoped* or *session-scoped*. This is the
  only place the "one kernel per process" / boot-bound-services limitation (M1) lives.
  **No numbered roadmap item owns this.** The current design keeps it process-singleton
  throughout, keyed per-execution by `ToolExecutionContext.cwd`/`.sessionId`.
- **Axis B — Filesystem isolation.** Isolated working trees per task so parallel mutating
  work does not clash on disk. Mechanism: git worktrees (**Workspaces**, roadmap item 3).
  Kept on the single kernel; only per-execution `cwd` changes.
- **Axis C — In-process scheduling & coordination.** How work is decomposed, queued,
  dispatched, run concurrently/async, retried, and communicated within one process. This
  covers the **Event System (4), Background Workers (5), Task/Execution Engine (7), and
  SubAgents (8)**. Their design docs are explicit that this concurrency is
  **process-internal, local-first**: Event §3.1 ("one process… one local workspace") with
  a bounded in-process worker pool; Planning's scheduler is kernel-side code and "a
  distributed planner is out of scope"; Memory's workers are an in-process FIFO queue with
  worker threads deferred. None of these needs a per-session kernel — they run on the
  single kernel and spawn parallel work *within* a session/task.

Mapping the features: **Workspaces = Axis B.** Event System, Background Workers,
Task/Execution Engine, SubAgents = **Axis C** (all assume single-kernel local-first).
**Axis A (per-session runtime scoping) is separate and currently unowned.**

**Rule.** Parallelism of *work* (C) is solved by scheduling + filesystem isolation (B),
all on one kernel. Do **not** map "parallel agents/tasks" to "fork a kernel/runtime per
agent" — that conflicts with the process-scoped event bus, worker pool, memory queue, and
Workspaces. Per-session runtimes (A) stay deferred until a concrete multi-session-
in-one-process requirement appears.

## Axis A (M1) — a human decision gate, deferred; bias toward minimalism

Whether and how to solve the per-session runtime-scoping limitation is **NOT decided
here**. It is a deliberate, deferred human decision, surfaced only when a concrete
multi-session-in-one-process host requirement actually appears. When that happens:

- **Present the full menu with pros/cons before building.** The candidate options are:
  1. **OS-process isolation** (spawn a separate agent/process per session/subagent; each
     gets its own kernel, heap, in-memory managers; durable state shared via disk + file
     locks). Isolation is free and M1 is moot, but there is no shared in-process event
     bus / memory queue and IPC is needed for coordination.
  2. **Per-session runtime factory** (in-process; one `KernelRuntime` + `ServiceProvider`
     per session). Strong in-process isolation; must keep process-scoped singletons
     (WorkspaceManager, event bus, worker pool, memory queue) separate.
  3. **Per-execution service routing** (keep one kernel; make only session-scoped
     services — settings, session — resolve per execution via the execution-context key).
     Lightest and most consistent with the existing per-execution `cwd`/`sessionId` model.
  4. **Host-contracts formalization** (a host layer supplying per-session runtimes/
     services).

  The choice is **host-model-dependent** (CLI/subprocess vs daemon/TUI embedding). It must
  be weighed by a human — an engineer/architect owner — not implicitly decided by
  whichever feature first touches a second session.
- **Bias: smallest implementation that is good enough, over maximal performance.** Pi
  values low complexity and small code volume. A slightly slower or less "optimal"
  solution that is far simpler and smaller is preferred even if it takes longer to build;
  avoid speculative generality and "the most performant system ever" unless a measured
  need justifies it. In practice that points at **Option 3** (or Option 1 for subprocess
  hosts) rather than a broad per-session runtime build — but the human decides.

When a need for Axis A appears, the model is: keep process-scoped services
(fs, process, event bus, worker pool, memory queue, `WorkspaceManager`) as singletons, and
route only the genuinely session-scoped services (settings, session) by the
execution-context key.

### How this maps to existing docs

- **Roadmap** (`docs/ROADMAP.md`) treats this as out-of-scope for every feature: no item
  owns Axis A; Workspaces (3) is Axis B; Event/Workers/Task/SubAgents (4/5/7/8) are Axis C.
- **Workspaces** (`docs/WORKSPACE_ARCHITECTURE.md` §12a) states that it builds on the
  single kernel, is Axis B only, `WorkspaceManager` is a process-scoped service by design,
  and it does **not** deliver the Axis A fix.
- **Leftovers tracker** (`docs/CAPABILITY_PLATFORM_STEP1_LEFTOVERS.md` M1 / M24) treats M1
  as a deferred human decision gate (host contracts, post-Workspaces), not covered by any
  roadmapped feature.
