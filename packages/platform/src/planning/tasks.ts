/**
 * Deterministic task-decomposition passes (Step 2.7): dedupe by deliverable,
 * `maxTasks` budget enforcement, and completion of the partial stage output onto
 * the full 2.1 `Task` shape.
 */

import type { CapabilityId, TaskId } from "../identifier/index.ts";
import { taskId } from "../identifier/index.ts";
import type { Task } from "../plan/index.ts";

/** The unordered task tuple a decomposition emits (§6.3.4 — no deps/priority). */
export interface DecomposedTask {
	id: string;
	title: string;
	purpose: string;
	deliverable: string;
}

/** Dedupe by deliverable; the first occurrence wins (stable). */
export function dedupeTasks(tasks: DecomposedTask[]): DecomposedTask[] {
	const seen = new Set<string>();
	const result: DecomposedTask[] = [];
	for (const task of tasks) {
		if (seen.has(task.deliverable)) {
			continue;
		}
		seen.add(task.deliverable);
		result.push(task);
	}
	return result;
}

/** Dedupe, then cap the decomposition to the `maxTasks` budget (§6.6). */
export function enforceMaxTasks(tasks: DecomposedTask[], maxTasks: number): DecomposedTask[] {
	return dedupeTasks(tasks).slice(0, Math.max(0, maxTasks));
}

/**
 * Complete partial tasks onto the full `Task` shape with empty default fields.
 * Later stages fill `dependsOn` (2.8), inputs/outputs, and verification.
 */
export function completeTasks(tasks: DecomposedTask[]): Task[] {
	return tasks.map((task) => ({
		id: taskId(task.id),
		title: task.title,
		purpose: task.purpose,
		deliverable: task.deliverable,
		inputs: [],
		outputs: [],
		dependsOn: [] as TaskId[],
		requiredCapabilities: [] as CapabilityId[],
		verification: "",
	}));
}
