/**
 * Execution overlay (§5, §12) — Step 2.12.
 *
 * Per-task runtime state kept strictly separate from plan content: a `Task` on
 * the plan carries no `status`/`priority`/`responsibleAgent`/`attempts`/`result`
 * (§5 is enforced structurally by `TaskSchema.additionalProperties: false`).
 * The overlay is the runtime's side-table keyed by plan + task id.
 *
 * In-memory only: persistence of the overlay for resume semantics is roadmap #7
 * (execution engine). The `priority` lives here, not in plan content — the
 * deterministic scheduler (§6.5) orders ready tasks by priority then id.
 */

import type { TaskId } from "../identifier/index.ts";
import type { Plan, Task } from "../plan/index.ts";

/** Lifecycle of a task under execution (§6.3 / §12). */
export const ExecutionTaskStatus = {
	Pending: "pending",
	Ready: "ready",
	Running: "running",
	Blocked: "blocked",
	Failed: "failed",
	Done: "done",
} as const;
export type ExecutionTaskStatus = (typeof ExecutionTaskStatus)[keyof typeof ExecutionTaskStatus];

/** One task's runtime state (overlay side, never part of `Task`). */
export interface ExecutionOverlayEntry {
	taskId: TaskId;
	status: ExecutionTaskStatus;
	/** Number of execution attempts so far (0 until first run). */
	attempts: number;
	/** The executor agent/capability responsible (walking skeleton: capability id). */
	responsibleExecutor: string | undefined;
	/** Scheduler ordering: lower runs first; tie-broken by task id. */
	priority: number;
	startedAt: number | undefined;
	endedAt: number | undefined;
	/** Structured result recorded on success. */
	result: string | undefined;
	/** Failure diagnostic recorded on failure. */
	error: string | undefined;
}

/** Options controlling how an overlay is attached to a plan. */
export interface ExecutionOverlayOptions {
	/** taskId → priority override (default 0). Only the scheduler reads this. */
	priorities?: Partial<Record<string, number>>;
}

/**
 * The runtime execution overlay for one plan: a map of task id → entry plus the
 * pure mutation helpers ("transitions are deterministic", §8/§12).
 */
export class ExecutionOverlay {
	readonly planId: string;
	private readonly entries: Map<string, ExecutionOverlayEntry>;

	constructor(planId: string, entries: ReadonlyArray<ExecutionOverlayEntry>) {
		this.planId = planId;
		this.entries = new Map(entries.map((entry) => [String(entry.taskId), entry]));
	}

	/** All entries, in insertion order (plan task order). */
	all(): ExecutionOverlayEntry[] {
		return [...this.entries.values()];
	}

	/** Look up one task's runtime state (undefined if the task is not in the overlay). */
	get(taskId: TaskId): ExecutionOverlayEntry | undefined {
		return this.entries.get(String(taskId));
	}

	/** Replace one task's entry (returns a new overlay; the input is not mutated). */
	with(entry: ExecutionOverlayEntry): ExecutionOverlay {
		const next = new Map(this.entries);
		next.set(String(entry.taskId), entry);
		return new ExecutionOverlay(this.planId, [...next.values()]);
	}
}

/**
 * Build the runtime overlay for a plan: one `pending` entry per task, with
 * `attempts 0`, no executor/result yet, and `priority` from `options.priorities`
 * (default 0). Pure — the plan is only read, never modified.
 */
export function attachOverlay(plan: Plan, options: ExecutionOverlayOptions = {}): ExecutionOverlay {
	const entries = plan.tasks.map((task: Task) => {
		const id = String(task.id);
		return {
			taskId: task.id,
			status: ExecutionTaskStatus.Pending as ExecutionTaskStatus,
			attempts: 0,
			responsibleExecutor: undefined,
			priority: options.priorities?.[id] ?? 0,
			startedAt: undefined,
			endedAt: undefined,
			result: undefined,
			error: undefined,
		};
	});
	return new ExecutionOverlay(plan.id, entries);
}

/** Mark a task as running (increments attempts; records executor + start time). */
export function markRunning(overlay: ExecutionOverlay, taskId: TaskId, responsibleExecutor: string): ExecutionOverlay {
	const entry = requireEntry(overlay, taskId);
	return overlay.with({
		...entry,
		status: ExecutionTaskStatus.Running,
		attempts: entry.attempts + 1,
		responsibleExecutor,
		startedAt: Date.now(),
		error: undefined,
	});
}

/** Mark a task done with its structured result. */
export function completeTask(overlay: ExecutionOverlay, taskId: TaskId, result: string): ExecutionOverlay {
	const entry = requireEntry(overlay, taskId);
	return overlay.with({
		...entry,
		status: ExecutionTaskStatus.Done,
		result,
		endedAt: Date.now(),
		error: undefined,
	});
}

/** Mark a task failed with a diagnostic. */
export function failTask(overlay: ExecutionOverlay, taskId: TaskId, error: string): ExecutionOverlay {
	const entry = requireEntry(overlay, taskId);
	return overlay.with({
		...entry,
		status: ExecutionTaskStatus.Failed,
		endedAt: Date.now(),
		error,
	});
}

function requireEntry(overlay: ExecutionOverlay, taskId: TaskId): ExecutionOverlayEntry {
	const entry = overlay.get(taskId);
	if (!entry) {
		throw new Error(`task ${String(taskId)} has no execution overlay entry`);
	}
	return entry;
}
