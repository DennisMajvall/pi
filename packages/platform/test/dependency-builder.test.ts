/**
 * Tests for the Dependency Builder (Step 2.8): deterministic artifact-I/O edges,
 * explicit ordering edges, the bounded AI fallback on ambiguous artifacts, edge
 * folding into `dependsOn`, and acyclicity (cycles reported, not thrown).
 */

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { planId, taskId } from "../src/identifier/index.ts";
import type { Task } from "../src/plan/index.ts";
import { buildDependencyGraph, type DependencyCandidate, type DependencyEdge } from "../src/planning/index.ts";
import { PlanSchema } from "../src/schema/plan.ts";

/** A task with populated inputs/outputs/capabilities (the enriched decomposition). */
function task(id: string, overrides: Partial<Task> = {}): Task {
	return {
		id: taskId(id),
		title: id,
		purpose: "purpose",
		deliverable: `deliverable-${id}`,
		inputs: [],
		outputs: [],
		dependsOn: [],
		requiredCapabilities: [],
		verification: "",
		...overrides,
	};
}

describe("deterministic artifact-I/O edges", () => {
	it("adds an edge from the sole producer to the consumer", async () => {
		const tasks = [task("t1", { outputs: ["schema"] }), task("t2", { inputs: ["schema"] })];
		const result = await buildDependencyGraph(tasks);
		expect(result.edges).toEqual([{ from: "t1", to: "t2" }]);
		expect(result.tasks.map((t) => String(t.dependsOn[0] ?? ""))).toEqual(["", "t1"]);
	});

	it("uses deliverable as a produced artifact", async () => {
		const tasks = [task("t1", { deliverable: "invoice set" }), task("t2", { inputs: ["invoice set"] })];
		const result = await buildDependencyGraph(tasks);
		expect(result.edges).toEqual([{ from: "t1", to: "t2" }]);
	});

	it("adds explicit ordering edges even when artifacts do not link", async () => {
		const tasks = [task("t1"), task("t2"), task("t3")];
		const result = await buildDependencyGraph(tasks, {
			explicitEdges: [
				{ from: "t1", to: "t2" },
				{ from: "t2", to: "t3" },
			],
		});
		expect(result.edges).toEqual([
			{ from: "t1", to: "t2" },
			{ from: "t2", to: "t3" },
		]);
		expect(result.tasks[2]!.dependsOn.map(String)).toEqual(["t2"]);
	});

	it("ignores an explicit edge whose endpoint is not a task", async () => {
		const result = await buildDependencyGraph([task("t1")], {
			explicitEdges: [{ from: "t1", to: "ghost" }],
		});
		expect(result.edges).toEqual([]);
	});
});

describe("bounded AI fallback on ambiguity", () => {
	it("surfaces ambiguous candidates when multiple producers match", async () => {
		const tasks = [
			task("a", { outputs: ["report"] }),
			task("b", { outputs: ["report"] }),
			task("c", { inputs: ["report"] }),
		];
		let seen: DependencyCandidate[] = [];
		const result = await buildDependencyGraph(tasks, {
			resolveAmbiguous: async (candidates) => {
				seen = candidates;
				return [{ from: candidates[0]!.producerIds[0]!, to: candidates[0]!.consumerId }];
			},
		});
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ producerIds: ["a", "b"], consumerId: "c", artifact: "report" });
		expect(result.edges).toEqual([{ from: "a", to: "c" }]);
	});

	it("does not call the fallback when there is no ambiguity", async () => {
		let called = false;
		await buildDependencyGraph([task("t1"), task("t2")], {
			resolveAmbiguous: async () => {
				called = true;
				return [];
			},
		});
		expect(called).toBe(false);
	});
});

describe("acyclicity", () => {
	it("reports an empty circularDependencies for a DAG and yields a valid plan", async () => {
		const tasks: Task[] = [
			task("t1", { outputs: ["a"] }),
			task("t2", { inputs: ["a"], outputs: ["b"] }),
			task("t3", { inputs: ["b"] }),
		];
		const result = await buildDependencyGraph(tasks);
		expect(result.circularDependencies).toEqual([]);
		const plan = {
			id: planId("plan-d"),
			schemaVersion: 1,
			goal: {
				summary: "x",
				successCriteria: [],
				unknowns: [],
				requiresClarification: false,
				clarificationQuestions: [],
			},
			policy: {
				taskKind: "implementation" as const,
				planningDepth: "medium" as const,
				hierarchicalRefinement: false,
				parallelExecution: true,
				specialistAgents: false,
				requireApproval: true,
				verificationLevel: "basic" as const,
				preferResearch: false,
				maxTasks: 10,
				dualPlanner: false,
			},
			constraints: [],
			assumptions: [],
			tasks: result.tasks,
			revisions: [],
			status: "draft" as const,
			createdAt: 1,
			updatedAt: 1,
		};
		expect(Value.Check(PlanSchema, plan)).toBe(true);
	});

	it("returns a cycle (not thrown) when the task graph is cyclic", async () => {
		const tasks: Task[] = [task("t1"), task("t2")];
		const edges: DependencyEdge[] = [
			{ from: "t1", to: "t2" },
			{ from: "t2", to: "t1" },
		];
		const result = await buildDependencyGraph(tasks, { explicitEdges: edges });
		expect(result.edges).toHaveLength(2);
		expect(result.circularDependencies.some((c) => c.length >= 3)).toBe(true);
	});
});
