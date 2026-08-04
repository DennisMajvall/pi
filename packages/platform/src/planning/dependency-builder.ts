/**
 * Dependency Builder (Architecture §6.3.5) — the first deterministic
 * orchestration core (Step 2.8).
 *
 * Builds the task DAG from the decomposed task set: derives dependency edges
 * deterministically (artifact I/O plus explicit ordering), folds them into each
 * task's `dependsOn`, and always validates acyclicity (DFS back-edge detection),
 * reporting `circularDependencies` to the Plan Critic (2.9) rather than ever
 * scheduling a cyclic graph.
 *
 * Consumes the *enriched* task list (inputs/outputs populated); the 2.12
 * orchestrator supplies it after Task Decomposition (2.7). Capability/skill
 * prerequisite rules (2.7 §6.3.5 rules 2/4) need artifact→capability/skill
 * metadata the 2.1 `Task` does not carry, so they are captured by the bounded
 * AI fallback (`resolveAmbiguous`) instead of hardcoded.
 */

import type { TaskId } from "../identifier/index.ts";
import { taskId } from "../identifier/index.ts";
import type { Task } from "../plan/index.ts";

/** A dependency edge: `from` must run before `to`. */
export interface DependencyEdge {
	from: string;
	to: string;
}

/** An ambiguous/unresolved artifact a consumer needs. */
export interface DependencyCandidate {
	/** Producer tasks whose produced artifact matches (possibly empty = unresolved). */
	producerIds: string[];
	consumerId: string;
	artifact: string;
}

export interface DependencyBuildOptions {
	/** Explicit ordering edges (user/constraint ordering). */
	explicitEdges?: DependencyEdge[];
	/** Bounded AI fallback: resolves ambiguous artifact edges (§6.3.5). */
	resolveAmbiguous?: (candidates: DependencyCandidate[]) => Promise<DependencyEdge[]>;
}

export interface DependencyBuildResult {
	/** Tasks with `dependsOn` folded in (sorted, deduped). */
	tasks: Task[];
	/** All edges (deterministic + explicit + fallback). */
	edges: DependencyEdge[];
	/** Detected cycles (empty if the graph is a DAG). */
	circularDependencies: string[][];
}

/** The artifact set a task produces. */
function producedSet(task: Task): Set<string> {
	return new Set([task.deliverable, ...task.outputs]);
}

/**
 * Build the task DAG. Deterministic rules first (artifact I/O, explicit
 * ordering), then the bounded AI fallback for ambiguous artifact edges, fold
 * edges into `dependsOn`, and validate acyclicity.
 */
export async function buildDependencyGraph(
	tasks: Task[],
	options: DependencyBuildOptions = {},
): Promise<DependencyBuildResult> {
	const producersOf = new Map<string, Task[]>(); // artifact → producer tasks
	for (const task of tasks) {
		for (const artifact of producedSet(task)) {
			const list = producersOf.get(artifact) ?? [];
			list.push(task);
			producersOf.set(artifact, list);
		}
	}

	const edges: DependencyEdge[] = [];
	const addEdge = (from: string, to: string): void => {
		edges.push({ from, to });
	};

	// Rule 1: artifact I/O. Exactly one producer → definite edge.
	const candidates: DependencyCandidate[] = [];
	for (const consumer of tasks) {
		for (const artifact of consumer.inputs) {
			const producers = producersOf.get(artifact) ?? [];
			if (producers.length === 1) {
				addEdge(producers[0]!.id, consumer.id);
			} else if (producers.length > 1) {
				candidates.push({ producerIds: producers.map((p) => p.id), consumerId: consumer.id, artifact });
			} else {
				candidates.push({ producerIds: [], consumerId: consumer.id, artifact });
			}
		}
	}

	// Rule 2: explicit ordering edges from the caller.
	for (const edge of options.explicitEdges ?? []) {
		if (tasks.some((t) => String(t.id) === edge.from) && tasks.some((t) => String(t.id) === edge.to)) {
			addEdge(edge.from, edge.to);
		}
	}

	// Rule 3: bounded AI fallback on ambiguity.
	if (candidates.length > 0 && options.resolveAmbiguous) {
		const resolved = await options.resolveAmbiguous(candidates);
		for (const edge of resolved) {
			if (!edges.some((e) => e.from === edge.from && e.to === edge.to)) {
				addEdge(edge.from, edge.to);
			}
		}
	}

	// Fold edges into dependsOn (dedup, sort).
	const dependsOnById = new Map<string, string[]>();
	for (const task of tasks) {
		dependsOnById.set(String(task.id), []);
	}
	for (const edge of edges) {
		const list = dependsOnById.get(edge.to) ?? [];
		if (!list.includes(edge.from)) {
			list.push(edge.from);
		}
	}
	for (const key of dependsOnById.keys()) {
		dependsOnById.get(key)!.sort();
	}

	const foldedTasks: Task[] = tasks.map((task) => ({
		...task,
		dependsOn: (dependsOnById.get(String(task.id)) ?? []).map((id) => taskId(id)) as TaskId[],
	}));

	return {
		tasks: foldedTasks,
		edges,
		circularDependencies: findCycles(tasks, edges),
	};
}

/** Find cycles in the directed graph (DFS back-edge detection), deduped. */
function findCycles(tasks: Task[], edges: DependencyEdge[]): string[][] {
	const adjacency = new Map<string, string[]>();
	for (const task of tasks) {
		adjacency.set(String(task.id), []);
	}
	for (const edge of edges) {
		const list = adjacency.get(edge.from) ?? [];
		list.push(edge.to);
		adjacency.set(edge.from, list);
	}
	for (const list of adjacency.values()) {
		list.sort();
	}

	const nodeIds = tasks.map((t) => String(t.id));
	const color = new Map<string, "white" | "gray" | "black">();
	for (const id of nodeIds) {
		color.set(id, "white");
	}
	const cycles: string[][] = [];

	const dfs = (node: string, path: string[]): void => {
		color.set(node, "gray");
		for (const next of adjacency.get(node) ?? []) {
			if (color.get(next) === "white") {
				dfs(next, [...path, next]);
			} else if (color.get(next) === "gray") {
				const start = path.indexOf(next);
				cycles.push([...path.slice(start), next]);
			}
		}
		color.set(node, "black");
	};

	for (const id of nodeIds) {
		if (color.get(id) === "white") {
			dfs(id, [id]);
		}
	}
	return dedupeCycles(cycles);
}

function dedupeCycles(cycles: string[][]): string[][] {
	const seen = new Set<string>();
	const result: string[][] = [];
	for (const cycle of cycles) {
		const canonical = canonicalCycle(cycle);
		const key = canonical.join("|");
		if (!seen.has(key)) {
			seen.add(key);
			result.push(canonical);
		}
	}
	return result;
}

/** Rotate a cycle so it starts at its lexically smallest element. */
function canonicalCycle(cycle: string[]): string[] {
	let start = 0;
	for (let i = 1; i < cycle.length; i++) {
		if (cycle[i]! < cycle[start]!) {
			start = i;
		}
	}
	return [...cycle.slice(start), ...cycle.slice(0, start)];
}
