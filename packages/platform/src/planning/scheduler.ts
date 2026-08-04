/**
 * Minimal deterministic scheduler (§6.5, §12) — Step 2.12.
 *
 * Scheduling is code, never the LLM: the approved plan's DAG is the scheduler's
 * only input (plus capability availability). This is a walking skeleton:
 *
 *   ready(t) = t unfinished ∧ all t.dependsOn done
 *   next    = argmin(ready tasks, by priority, then id)
 *
 * `ready(t)` flows from `Task.dependsOn`; `next` picks by the overlay `priority`
 * then the task id — determinism with no AI in execution order. `requiredCapabilities`
 * resolve to registry capabilities via an injected resolver. Full parallel
 * scheduling, resume, and retry are roadmap #7.
 */

import type { CapabilityId, TaskId } from "../identifier/index.ts";
import type { Plan, Task } from "../plan/index.ts";
import {
	completeTask,
	type ExecutionOverlay,
	ExecutionTaskStatus,
	failTask,
	markRunning,
} from "./execution-overlay.ts";

/** A capability the scheduler can resolve and invoke for execution. */
export interface SchedulerCapability {
	id: CapabilityId;
	manifestId: string;
	name: string;
	/** Invoke the capability's exported run (walking skeleton). */
	run: (input: unknown) => Promise<unknown>;
}

/** How a task's `requiredCapabilities` resolve at execution time (§12). */
export type CapabilityResolver = (capabilityId: CapabilityId) => SchedulerCapability | undefined;

/** The resolved + missing capability lists for one task. */
export interface CapabilityResolution {
	resolved: SchedulerCapability[];
	missing: CapabilityId[];
}

/**
 * `ready(t)`: a task is ready when it is unfinished (`pending`) and every task
 * it `dependsOn` is `done` in the overlay. Returns the ready task ids in plan
 * order. Deterministic, no model involvement.
 */
export function schedulerReady(plan: Plan, overlay: ExecutionOverlay): TaskId[] {
	const statusOf = new Map<string, ExecutionOverlayEntryStatus>();
	for (const entry of overlay.all()) {
		statusOf.set(String(entry.taskId), entry.status);
	}
	const ready: TaskId[] = [];
	for (const task of plan.tasks) {
		const status = statusOf.get(String(task.id));
		if (status !== ExecutionTaskStatus.Pending) {
			continue; // already/never schedulable in this skeleton
		}
		const depsDone = task.dependsOn.every((dep) => statusOf.get(String(dep)) === ExecutionTaskStatus.Done);
		if (depsDone) {
			ready.push(task.id);
		}
	}
	return ready;
}

/**
 * `next`: the argmin over ready tasks by **(priority, then id)**. `priority`
 * comes from the overlay (never plan content); ids break ties so the result is
 * total and reproducible.
 */
export function schedulerNext(plan: Plan, overlay: ExecutionOverlay): TaskId | undefined {
	const ready = schedulerReady(plan, overlay);
	if (ready.length === 0) {
		return undefined;
	}
	const priorityOf = new Map<string, number>();
	for (const entry of overlay.all()) {
		priorityOf.set(String(entry.taskId), entry.priority);
	}
	let best = ready[0]!;
	let bestKey = sortKey(best, priorityOf);
	for (const candidate of ready.slice(1)) {
		const key = sortKey(candidate, priorityOf);
		if (key < bestKey) {
			best = candidate;
			bestKey = key;
		}
	}
	return best;
}

type ExecutionOverlayEntryStatus = (typeof ExecutionTaskStatus)[keyof typeof ExecutionTaskStatus];

/** Total order key: priority first, then the id string. */
function sortKey(id: TaskId, priorityOf: Map<string, number>): string {
	const priority = priorityOf.get(String(id)) ?? 0;
	return `${String(priority).padStart(12, "0")}:${String(id)}`;
}

/**
 * Resolve a task's `requiredCapabilities` through the injected resolver.
 * Missing capability ids are reported (not silently skipped) so a plan whose
 * capabilities are unavailable surfaces the gap to the executor.
 */
export function resolveRequiredCapabilities(task: Task, resolve: CapabilityResolver): CapabilityResolution {
	const resolved: SchedulerCapability[] = [];
	const missing: CapabilityId[] = [];
	for (const capId of task.requiredCapabilities) {
		const capability = resolve(capId);
		if (capability) {
			resolved.push(capability);
		} else {
			missing.push(capId);
		}
	}
	return { resolved, missing };
}

/**
 * The walking-skeleton executor: mark `running`, invoke the resolved capability,
 * record the result on success and mark `done`, or mark `failed` with a
 * diagnostic on throw. This is the "resolve a ready task to a capability
 * execution" proof (§12); multi-task autonomous orchestration is roadmap #7.
 */
export async function executeTask(
	task: Task,
	capability: SchedulerCapability,
	overlay: ExecutionOverlay,
	input: unknown,
): Promise<ExecutionOverlay> {
	const next = markRunning(overlay, task.id, capability.id);
	try {
		const output = await capability.run(input);
		return completeTask(next, task.id, stringifyResult(output));
	} catch (error) {
		return failTask(next, task.id, toError(error).message);
	}
}

/**
 * Walking-skeleton demo helper: deterministically walk the approved plan's DAG,
 * executing each ready task in dependency order (serial; `parallelExecution`
 * only bounds concurrency, which is #7). Returns the final overlay.
 */
export async function executeApprovedPlan(
	plan: Plan,
	overlay: ExecutionOverlay,
	resolve: CapabilityResolver,
	inputFor: (task: Task) => unknown,
): Promise<ExecutionOverlay> {
	let current = overlay;
	// Safe guard against an unexpected cycle stalling the walk.
	const guard = new Set<string>();
	for (;;) {
		const next = schedulerNext(plan, current);
		if (!next) {
			break;
		}
		const key = String(next);
		if (guard.has(key)) {
			throw new Error(`executeApprovedPlan: task ${key} scheduled more than once; aborting to avoid a loop`);
		}
		guard.add(key);
		const task = requireTask(plan, next);
		const { resolved, missing } = resolveRequiredCapabilities(task, resolve);
		const capability = resolved[0];
		if (!capability) {
			current = failTask(current, next, `no resolvable capability for ${missing.join(", ") || "(none)"}`);
			continue;
		}
		current = await executeTask(task, capability, current, inputFor(task));
	}
	return current;
}

function requireTask(plan: Plan, id: TaskId): Task {
	const task = plan.tasks.find((t) => String(t.id) === String(id));
	if (!task) {
		throw new Error(`task ${String(id)} not found in plan ${plan.id}`);
	}
	return task;
}

function stringifyResult(output: unknown): string {
	if (output === undefined || output === null) {
		return "ok";
	}
	return typeof output === "string" ? output : JSON.stringify(output);
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
