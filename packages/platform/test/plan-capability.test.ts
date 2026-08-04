/**
 * Tests for Step 2.13.1: the PlanCapabilityRunner + view model — the seam the TUI
 * plan view and any review surface drive. list/load are read-through; review
 * honors the gate and emits plan.approved; edit is schema-preserving.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { capabilityId, planId, taskId } from "../src/identifier/index.ts";
import { PlanStore } from "../src/kernel/plan-store.ts";
import type { Plan, Task } from "../src/plan/index.ts";
import { createPlanCapabilityRunner, type PlanCapabilityRunner, planListEntry } from "../src/planning/index.ts";
import { PlanSchema } from "../src/schema/plan.ts";
import type { EventBusService } from "../src/service/index.ts";

const tempDirs: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-platform-cap-"));
	tempDirs.push(root);
	return root;
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

function task(id: string, overrides: Partial<Task> = {}): Task {
	return {
		id: taskId(id),
		title: id,
		purpose: "purpose",
		deliverable: `deliverable-${id}`,
		inputs: [],
		outputs: [],
		dependsOn: [],
		requiredCapabilities: [capabilityId("tool.read")],
		verification: "",
		...overrides,
	};
}

function samplePlan(id: string, overrides: Partial<Plan> = {}): Plan {
	return {
		id: planId(id),
		schemaVersion: 1,
		goal: {
			summary: `Ship ${id}`,
			successCriteria: ["deliverable-t1"],
			unknowns: [],
			requiresClarification: false,
			clarificationQuestions: [],
		},
		policy: {
			taskKind: "implementation",
			planningDepth: "medium",
			hierarchicalRefinement: false,
			parallelExecution: true,
			specialistAgents: false,
			requireApproval: true,
			verificationLevel: "basic",
			preferResearch: false,
			maxTasks: 5,
			dualPlanner: false,
		},
		constraints: [],
		assumptions: [],
		tasks: [task("t1")],
		revisions: [],
		status: "draft",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function fakeEvents(): EventBusService {
	return { emit: async () => {}, emitSync: async () => {} } as unknown as EventBusService;
}

describe("plan list view model (Step 2.13.1)", () => {
	it("builds a display entry from a plan (title/status/version/task count)", () => {
		const entry = planListEntry(
			samplePlan("a", {
				metrics: {
					completeness: 90,
					confidence: 70,
					parallelism: 50,
					risk: "low",
					unknownCount: 0,
					missingInformation: [],
				},
			}),
		);
		expect(entry).toMatchObject({ id: "a", title: "Ship a", status: "draft", taskCount: 1 });
		expect(entry.version).toBe(1);
		expect(entry.metrics).toContain("completeness 90");
	});

	it("lists persisted plans read-through with their goal titles", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		await store.save(samplePlan("a"));
		await store.save(samplePlan("b", { status: "needs_review" }));
		const runner = createPlanCapabilityRunner({ store, events: fakeEvents() });

		const entries = await runner.list();
		expect(entries.map((e) => e.id)).toEqual(["a", "b"]);
		expect(entries.find((e) => e.id === "b")?.status).toBe("needs_review");
	});

	it("load() re-reads from disk (external edit picked up via read-through)", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const saved = samplePlan("a");
		await store.save(saved);
		const runner = createPlanCapabilityRunner({ store, events: fakeEvents() });

		// Simulate an external edit directly on disk, bypassing the runner.
		await store.save({ ...saved, constraints: [{ kind: "hard", description: "No cloud" }] });
		const loaded = await runner.load("a");
		expect(loaded.constraints).toEqual([{ kind: "hard", description: "No cloud" }]);
	});
});

describe("plan capability runner review/edit (Step 2.13.1)", () => {
	it("review(approve) moves a needs_review plan to approved and emits plan.approved", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		let approvedEmitted = 0;
		const events = {
			emit: async (e: { type: string }) => void (e.type === "plan.approved" && approvedEmitted++),
			emitSync: async () => {},
		} as unknown as EventBusService;
		await store.save(samplePlan("a", { status: "needs_review" }));
		const runner: PlanCapabilityRunner = createPlanCapabilityRunner({ store, events });

		const result = await runner.review("a", "approve");
		expect(result.status).toBe("approved");
		expect(result.revisions.at(-1)?.reason).toBe("approval");
		expect(approvedEmitted).toBe(1);

		const persisted = await store.load("a");
		expect(persisted.status).toBe("approved");
	});

	it("review(approve) under a required gate does not force-approve a still-draft plan", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		await store.save(samplePlan("a")); // draft, requireApproval true
		const runner = createPlanCapabilityRunner({ store, events: fakeEvents() });

		const result = await runner.review("a", "approve");
		expect(result.status).toBe("needs_review"); // lands awaiting the human, not force-approved
	});

	it("edit() applies a conversational directive, schema-preserving, and persists", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		await store.save(samplePlan("a"));
		const runner = createPlanCapabilityRunner({ store, events: fakeEvents() });

		const edited = await runner.edit("a", "rename task t1 to Bootstrap");
		expect(edited.tasks.find((t) => String(t.id) === "t1")?.title).toBe("Bootstrap");
		expect(Value.Check(PlanSchema, edited)).toBe(true);

		const loaded = await store.load("a");
		expect(loaded.tasks.find((t) => String(t.id) === "t1")?.title).toBe("Bootstrap");
	});

	it("edit() accepts a typed PlanEdit and bumps a user_edit revision", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		await store.save(samplePlan("a"));
		const runner = createPlanCapabilityRunner({ store, events: fakeEvents() });

		const edited = await runner.edit("a", { op: "rename", task: "t1", title: "Init" });
		expect(edited.tasks.find((t) => String(t.id) === "t1")?.title).toBe("Init");
		expect(edited.revisions.at(-1)?.reason).toBe("user_edit");
	});
});
