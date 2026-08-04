# Pi Workspace Architecture & Isolation Layer

**Status:** Architecture design (pre-implementation)
**Scope:** Design only. No implementation yet.
**Related:** `docs/PLANNING_ARCHITECTURE.md`, `docs/CAPABILITY_PLATFORM_CONTRACTS.md`, `docs/capability-platform/RUNTIME_KERNEL_DESIGN.md` (Steps 1.2/1.3)

---

## 1. Executive Summary & Objective

Multiple agents modifying the same checkout conflict with one another, preventing safe parallel execution.

This feature introduces an isolated execution environment — the **Workspace** — backed permanently by **Git worktrees**, provisioned and controlled by a centralized **Workspace Manager**.

**Primary design constraint: encapsulation, not polymorphism.** We are isolating the rest of Pi from Git commands, *not* building an abstraction layer to swap Git for containers or VMs later. If worktrees are ever replaced, the implementation is migrated directly — no factory interfaces, no backend flags, no capability gates for hypothetical backends.

---

## 2. Architectural Principles & Non-Goals

### Design Philosophy

- **Workspace is a domain concept; Git worktree is the implementation detail.** Agents never know they are working inside a worktree and never execute Git commands directly.
- **No pluggable backend over-engineering.** No abstract factory, no backend registry, no `isContainer`/`gitBackend` flags. OverlayFS, Docker, and VMs are explicitly out (see §3).
- **Decoupled from orchestration.** Execution infrastructure (`Workspace`) stays independent of orchestration state (`Session`, `Plan`, `Task`). The manager knows nothing about plans or tasks beyond the ids it is handed.
- **One manager owns all Git.** No other component — agent, tool, executor — touches `git`. The Manager's API is the only Git boundary.
- **Deterministic where possible.** Allocation, naming, reaping, and merge bookkeeping are code. The LLM never sees Git.

### Non-Goals

- No simultaneous multi-backend support (no toggling between containers and worktrees).
- No exposure of branches, HEADs, index, or other Git concepts to the agent layer.
- No environment/dependency isolation (we solve filesystem concurrency, not packaging).
- No git-mirroring for non-git repositories (see §11 for the degradation path).

---

## 3. Evaluated Alternatives (Why Worktrees)

| Approach                              | Verdict      | Technical Rationale                                                                                           |
| ------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------- |
| **Git worktrees**                     | **Selected** | Native Git integration; instant provisioning; shared `.git` object store; true filesystem isolation per task. |
| **Branch-per-task (single checkout)** | Rejected     | Agents overwrite each other's files in the working directory; breaks concurrency.                             |
| **Full `git clone` per task**         | Rejected     | Extreme disk/CPU overhead; slow provisioning; redundant object databases.                                     |
| **OverlayFS / CoW clones**            | Rejected     | Platform-dependent (Linux-only); complex OS-level mount privileges and cleanup edge cases.                    |
| **Containers / Cloud VMs**            | Rejected     | High startup latency; solves dependency isolation which is out of scope for Pi's parallelism requirements.    |

---

## 4. Domain Model & Hierarchy

```text
Session (user conversation & orchestration state)
  │
  ├─ Plan (decomposed unit of intent)
  │    └─ Task 1 ──> executes in ──> Workspace A   (record: pi/wrk-<uuid>, base <sha>)
  │    └─ Task 2 ──> executes in ──> Workspace B
  │    └─ Task 3 ──> executes in ──> (no workspace: research task, read-only)
  │
  └─ WorkspaceManager (platform service; owns Git lifecycle & worktree controller)
       └─ ownership registry (per-session records: workspace → path/branch/state)
```

- **Session:** user conversation + orchestration state. Owns plans and, indirectly, the workspaces allocated by its tasks.
- **Plan:** decomposed unit of intent (see `docs/PLANNING_ARCHITECTURE.md`).
- **Task:** actionable unit of work delegated to an agent.
- **Workspace:** the physical filesystem execution environment allocated to a task.

**Allocation rules:**

- **At most one *active* workspace per task at any moment.** Sequential retries/replans allocate a fresh workspace after the previous one is deleted or quarantined (a new workspace id, never reuse).
- **Workspace id ≠ task id.** Task ids are session-scoped and stable across replans; workspace ids are globally unique and one-shot. Retrying a task yields a new workspace.
- **Read-only tasks (research, review) need no workspace.** They run against the main checkout read-only. Workspace isolation exists for tasks that mutate the filesystem.

---

## 5. Concepts: Agent-Facing Handle vs Manager-Owned Record

Mirror the plan-vs-execution-state split from `PLANNING_ARCHITECTURE.md` §5: the lean handle agents see, and the full record the manager persists. Never merge them.

### Agent-facing `Workspace` (lean, stable)

```ts
export interface Workspace {
  /** Globally unique workspace instance id (WorkspaceId branded type) */
  id: WorkspaceId;
  /** Absolute path to the isolated working directory root */
  root: string;
  /** Audit fields populated by the manager; agents must not read or rely on them */
  branch?: string;
  baseCommit?: string;
}
```

No implementation-specific booleans (`isContainer`, `gitBackend`). Agents consume `id` + `root` only.

### Manager-owned `WorkspaceRecord` (persisted, internal)

```ts
export type WorkspaceState =
  | "allocating" | "active" | "syncing" | "merging"
  | "conflict" | "merged" | "deleted" | "stale";

export interface WorkspaceRecord {
  id: WorkspaceId;
  sessionId: SessionId;
  taskId: string;            // informational; manager does not interpret it
  root: string;
  branch: string;            // pi/<workspace-id> — globally unique (see §6.2)
  baseCommit: string;        // resolved commit SHA the workspace was created from
  state: WorkspaceState;
  createdAt: number;
  updatedAt: number;
}
```

The record is the **ownership registry**: `cleanup()` only touches worktrees pi created (identified via the registry + `git worktree list --porcelain`). This is what makes crash recovery safe (§9).

---

## 6. The WorkspaceManager API and Internals

### Public API

```ts
export interface WorkspaceCreateOptions {
  sessionId: SessionId;
  taskId: string;
  /** Base for the new branch. Branch name or commit SHA; the manager resolves to a SHA. Default: current HEAD of the default branch. */
  baseCommit?: string;
}

export interface MergeResult {
  success: boolean;
  mergedCommit?: string;     // when success
  conflictPaths?: string[];  // when conflict
  message?: string;
}

export interface WorkspaceManager {
  create(options: WorkspaceCreateOptions): Promise<Workspace>;
  get(id: WorkspaceId): Promise<Workspace | null>;
  getRecord(id: WorkspaceId): Promise<WorkspaceRecord | null>;
  list(sessionId?: SessionId): Promise<WorkspaceRecord[]>;
  /** Update the workspace from the base/target branch (rebase). See §7. */
  sync(id: WorkspaceId, targetBranch: string): Promise<MergeResult>;
  /** Stage + commit the agent's changes, then merge into the target branch. See §7. */
  merge(id: WorkspaceId, targetBranch: string): Promise<MergeResult>;
  /** Abort an in-progress merge/rebase, returning the workspace to a usable state. */
  abortMerge(id: WorkspaceId): Promise<void>;
  delete(id: WorkspaceId): Promise<void>;
  /** Reap stale worktrees and orphaned branches per the ownership registry. */
  cleanup(sessionId?: SessionId): Promise<CleanupResult>;
}
```

### Internal responsibilities (Manager owns 100%)

1. **Path generation** — deterministic, collision-free, *outside the repo*: `~/.pi/workspaces/<session-id>/<workspace-id>`. Git refuses worktrees nested inside another worktree, so workspace roots never live inside the checkout.
2. **Branch naming** — `pi/<workspace-id>` where the workspace id is a UUID. **Never `pi/task-<id>`**: task ids collide across sessions and across retries, and git forbids checking out the same branch twice. The UUID scheme is globally unique by construction.
3. **Base resolution** — resolve `baseCommit` (branch name or SHA) to a concrete SHA *before* `git worktree add`. Creating the branch from a SHA sidesteps the "branch is already checked out" failure entirely.
4. **Provisioning** — `git worktree add -b pi/<uuid> <root> <sha>`.
5. **Locking & concurrency** — three layers:
   - *In-process:* an async mutex serializing `create/merge/sync/delete/cleanup` per manager instance.
   - *Cross-process:* a file lock via `proper-lockfile` (already a dependency, used by `SettingsManager`) on `~/.pi/workspaces/.lock`, so concurrent pi processes cannot race branch creation or prune each other's worktrees.
   - *Git-side:* never fight git's own locks; on lock errors, retry with backoff, then surface a typed error.
6. **Git error encapsulation** — catch git stderr (dirty trees, lock files, "already checked out", missing refs) and rethrow typed domain errors: `WorkspaceCreationError`, `WorkspaceMergeConflictError`, `WorkspaceNotFoundError`, `WorkspaceLockedError`.
7. **Commit-on-merge** — agents never commit. At merge time the manager stages and commits the workspace's changes itself (`git -C <root> add -A && git -C <root> commit -m "pi: <workspace-id>"`), then merges.
8. **Garbage collection** — `cleanup()` per §9, driven by the ownership registry, never a blanket wipe.

---

## 7. Lifecycle & Execution Flow

### State machine

```text
allocating ──► active ──► syncing ──► active (rebase done)
   │            │           │
   │            ├──► merging ──► merged ──► deleted
   │            │       │
   │            │       └──► conflict ──► (user resolution) ──► merged | deleted
   │            │                    └──► abortMerge ──► active | deleted
   │            └──► (crash) stale ──► reaped by cleanup
   └──► (create failed) deleted
```

Transitions are deterministic and recorded in `WorkspaceRecord.state`.

### Runtime flow

1. **Allocation** — the plan executor (see `docs/PLANNING_ARCHITECTURE.md` §12) initiates a task that mutates filesystem; calls `workspaceManager.create({ sessionId, taskId, baseCommit })`.
2. **Provisioning** — manager resolves base → SHA, takes the lock, `git worktree add -b pi/<uuid> <root> <sha>`, writes the record (`allocating → active`), returns the lean `Workspace`.
3. **Execution** — the delegated agent receives `Workspace.root`. Every file-system tool executes with `cwd = workspace.root` (the platform's `ToolExecutionContext.cwd`, §12). The agent never calls Git; agent-facing git tools/prompts are removed.
4. **Sync (optional)** — long-running tasks may call `sync(id, targetBranch)` to rebase onto newer main. On conflict: abort the rebase, surface, or continue on the stale base (policy).
5. **Completion & merge** — orchestrator calls `merge(id, targetBranch)`. Manager verifies the *main* worktree is clean and on the target branch (refuses otherwise), stages + commits the workspace branch, then `git merge --no-ff` (default; keeps task boundaries auditable). Success → `merged`.
6. **Conflict** — `merge` returns `conflictPaths` and sets state `conflict` (§8).
7. **Teardown** — orchestrator calls `delete(id)`: `git worktree remove --force <root>` (dirty trees are expected), `git worktree prune`, remove the registry record.

### Merge details

- **Default strategy:** `--no-ff` merge commit — preserves the task boundary in history and makes the diff attributable. A policy may choose fast-forward or rebase for linear history; the choice lives in the manager's config, never in the LLM.
- **Precondition:** the target branch must be checked out in the main worktree and clean. If not, the manager defers to the user instead of mutating their checkout.
- **Commit authorship:** commits are authored by the user/orchestrator identity (config), not the agent.

---

## 8. Conflict Resolution

Conflicts are expected under parallel execution; the design must make them cheap and deterministic to surface.

1. `merge` detects conflicts → sets state `conflict`, returns `conflictPaths`, leaves the merge in progress (no `--abort` yet).
2. The plan executor **pauses dependent tasks** (scheduler: dependent tasks are `blocked` until resolution), and surfaces the conflict to the user with the affected paths (interactive mode).
3. Resolution options:
   - **User resolves in the main checkout**, then manager finalizes the merge (`merged`).
   - **Retry-in-fresh-workspace:** orchestrator requests a *new* workspace from the current main tip and re-runs the task (verification/replanning path from `PLANNING_ARCHITECTURE.md` §13). The conflicted workspace is `delete`d.
   - **Abort** (`abortMerge`): `git merge --abort`, state back to `active` or `deleted`.
4. Resolution policy (`policy.verificationLevel`, conflict retry budget) is deterministic and enforced by the executor; the LLM does not decide.

---

## 9. Cleanup & Crash Recovery

The manager's `cleanup()` is the only component that ever removes worktrees, and it is **registry-driven**:

1. Load the ownership registry (`~/.pi/workspaces/*/<workspace-id>.json` or a single index).
2. Read `git worktree list --porcelain` to see what actually exists on disk.
3. For each registered record that is:
   - `allocating`/`syncing`/`merging` **stuck** (updatedAt older than threshold, e.g. 1h), or
   - `active` but its session is gone, or
   - older than the reap horizon (default: session end + grace period),
   → `git worktree remove --force <root>` (or `rm -rf` when git reports the worktree missing), delete the branch ref (`git branch -D pi/<uuid>`), prune, and remove the record.
4. Reap-on-session-end: when a session closes, its workspaces are deleted (or, for crash recovery, marked for the next `cleanup()`).

Safety invariants:

- Only worktrees with a matching registry record and a `pi/<uuid>` branch are ever touched. The user's own worktrees are never removed.
- `git worktree prune` is run after any removal so `.git/worktrees` stays consistent.
- `cleanup` runs under the same cross-process lock as everything else.

---

## 10. Isolation Guarantees & Limits

**Isolated per workspace:**

- Working tree (files) and index.
- Local commits on the workspace branch (until merged).

**Shared / NOT isolated (by design):**

- Git object database (the point of worktrees).
- Environment variables, user home, dependency caches (`~/.npm`, `~/.cargo`, etc.) unless explicitly redirected per task.
- Any path the agent is pointed at outside `Workspace.root`. Isolation is enforced by **cwd discipline**, not by OS sandboxing: every tool execution gets `cwd = workspace.root`, and workspace-relative paths are rejected outside it (the platform's `FileSystemService` path resolution).

Honest framing for PRs/discussions: this layer isolates *file writes*, not *processes*. A malicious or buggy agent can still read user files via absolute paths; enforcement is the tool layer's cwd + path policy, not a security boundary.

---

## 11. Degradation Paths

| Condition | Behavior |
|-----------|----------|
| Not a git repository | `create` throws a typed error; the orchestrator runs filesystem-mutating tasks serially in the main checkout (no isolation), and the plan exposes the limitation in its assumptions. No fake backend. |
| Merge conflict | §8 — pause dependents, surface, retry-in-fresh-workspace or user resolution. |
| Crash mid-allocation | Record stuck in `allocating`; reaped by `cleanup()` via the registry. |
| Worktree dir deleted externally | `git worktree prune` + registry cleanup; branch ref removed if merged or reaped. |
| Git unavailable / not installed | Same as non-git repo: typed error, serial fallback. |

---

## 12. Integration with the Pi Platform & Planning

The Workspace layer is infrastructure — a platform service, not a capability:

- **`WorkspaceManager` is a platform service** alongside `FileSystemService`/`ProcessService` in the kernel's `ServiceProvider` (Step 1.3). It is deterministic code; the LLM never calls it directly. It is process-scoped by design (see §12a), independent of the deferred per-session runtime-scoping item.
- **`WorkspaceId` is the branded identifier** from the platform contracts (`@earendil-works/pi-platform/identifier`), giving workspaces first-class identity.
- **Execution cwd**: the platform `ToolExecutionContext.cwd` (capability contracts) is set to `Workspace.root` for every tool call during a task. No agent-facing API change — the workspace is invisible by design.
- **Events**: `workspace.created`, `workspace.synced`, `workspace.merged`, `workspace.conflict`, `workspace.deleted`, `workspace.reaped` over the `EventBusService` (new canonical event types, added to the platform event constants when implemented) — observability + multi-frontend support.
- **Orchestrator**: the plan executor from `PLANNING_ARCHITECTURE.md` §12 is the sole caller. Task with `requiredCapabilities` that mutate filesystem → allocate a workspace; read-only tasks → no workspace. Verification runs inside the workspace before merge; failed verification feeds the fix/replan path.
- **Session lifecycle**: the executor deletes a session's workspaces on session end; `cleanup()` covers the crashed-process case.

---

## 12a. Scope Note: Runtime Model (single kernel per process) & Concurrency Axes

This design **assumes the current single-kernel-per-process runtime** (one
`KernelRuntime` and one `ServiceProvider` per process, boot-bound at
`ensurePlatformRuntime`) and is fully compatible with it: a session can own many
tasks, each executing in its own workspace, all served by that one kernel. `Workspace.root`
replaces the per-execution **cwd** (`ToolExecutionContext.cwd`), not the service binding.

**The full cross-cutting framework (the three parallelism axes A/B/C and the M1 /
per-session-runtime human decision gate) lives in `docs/RUNTIME_MODEL.md`.** This
section keeps only what is specific to Workspaces (Axis B) vs that model.

- Workspaces is **Axis B — filesystem isolation**: a separate, isolated working tree per
task (git worktrees) on the single kernel; only per-execution `cwd` changes. It is not
Axis A (runtime scoping) or Axis C (in-process scheduling).
- **`WorkspaceManager` is a process-scoped platform service by design.** It holds the
  cross-process Git lock and coordinates all worktrees repository-wide, so it must stay a
  process singleton — never duplicated per session or per workspace.
- This document does **not** deliver the per-session runtime fix (Axis A / M1). That
  concern — multiple `AgentSession`s in one process each needing their own session-scoped
  service state (settings, session) behind `ctx.settings` / `ctx.session` — is a separate
  **runtime-scoping / host-contracts** item, tracked independently (`docs/RUNTIME_MODEL.md`,
  `docs/CAPABILITY_PLATFORM_STEP1_LEFTOVERS.md` M1) and designed only after Workspaces
  (its multi-session execution data drives which services are truly session-scoped vs.
  naturally process-scoped, e.g. fs/process/WorkspaceManager). It is distinct from, and
  not required by, the Axis C features (Events/Workers/Execution Engine/SubAgents), which
  are process-internal concurrency on the single kernel.

## 13. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Merge conflicts under parallelism | Blocked tasks, user friction | Deterministic conflict surfacing (§8), retry-in-fresh-workspace, pause dependents |
| Branch/worktree accumulation | Repo clutter, disk growth | Registry-driven `cleanup()` + reap-on-session-end (§9) |
| Cross-process races (CLI + server) | Corrupt worktree registry | `proper-lockfile` cross-process lock + in-process mutex (§6.5) |
| Agents escaping cwd discipline | Writes outside workspace | Tool-layer path policy: reject absolute paths outside `Workspace.root`; integration tests |
| User's main checkout mutated by merge | Data loss | Merge precondition (clean main worktree on target branch) enforced; never checkout/switch in the main worktree |
| Git state drift after crashes | Stuck workspaces | State machine + `cleanup()` reaping stuck states |
| Long-running tasks on stale base | Unnecessary conflicts | Optional `sync()` rebase (§7.4) |
| Windows path/permission quirks | Flaky provisioning | Run under the same cross-platform test matrix as the rest of pi; treat `worktree remove --force` + prune as the standard teardown |

---

## 14. Open Questions

- **Merge history policy:** `--no-ff` by default — confirm with real usage whether fast-forward/rebase should be configurable per repo.
- **Sync cadence:** automatic rebase on a timer vs explicit `sync()` from the orchestrator only.
- **Registry format:** per-workspace JSON files vs a single index (affects atomicity and cleanup simplicity).
- **Reap thresholds:** session-end + grace vs age-based only; how aggressively to reclaim after crashed processes.
- **Conflict UX:** where in interactive mode the conflict is surfaced and how resolution is confirmed.
- **Read-only task detection:** deterministic (task declares no mutating capabilities) vs heuristic.

---

## 15. Implementation Checklist

- [ ] `WorkspaceManager` around `git worktree add/remove/prune` only; no other component runs git.
- [ ] UUID workspace ids; branches named `pi/<workspace-id>`; base resolved to a SHA before `worktree add`.
- [ ] Ownership registry (`~/.pi/workspaces/...`) written/read for every create/delete; `cleanup()` registry-driven.
- [ ] In-process mutex + `proper-lockfile` cross-process lock around all manager mutations.
- [ ] Typed domain errors for all git failures (`WorkspaceCreationError`, `WorkspaceMergeConflictError`, ...).
- [ ] Commit-on-merge (stage + commit + `--no-ff` merge) with the clean-main-worktree precondition.
- [ ] `sync()` (rebase) and `abortMerge()`.
- [ ] Conflict flow: state `conflict`, `conflictPaths` surfaced, dependents paused.
- [ ] `Workspace.root` as `ToolExecutionContext.cwd` for all task tool calls; path policy rejects writes outside root.
- [ ] Remove agent-facing git tools/prompts.
- [ ] Session-end reap + crash `cleanup()`.

### Tests

- [ ] Two parallel agents writing the same relative path in different workspaces produce distinct, non-colliding files.
- [ ] N concurrent `create()` calls (N = 8+) under one manager never race branch creation (serialized, unique branches).
- [ ] Merge conflict → `conflictPaths` returned, `abortMerge` restores a usable workspace, retry-in-fresh-workspace succeeds.
- [ ] Crash recovery: simulate stuck `allocating`/`active` records; `cleanup()` reaps only registered `pi/<uuid>` worktrees and never user worktrees.
- [ ] Cross-process: two manager instances (two processes) run `create`/`cleanup` without corrupting the registry.
- [ ] Agent tool calls outside `Workspace.root` are rejected.
- [ ] Non-git repo: `create` throws the typed error; executor falls back to serial execution.
