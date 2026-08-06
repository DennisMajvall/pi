/**
 * Tests for the AI-driven plan edit fallback (Step 2.13.5 extension).
 *
 * When the deterministic directive parser does not recognize a free-form edit,
 * `/plans` falls back to the session model (`aiEditPlan`): the model returns the
 * full edited plan as strict JSON, validated against `PlanSchema` and the DAG
 * invariants, then persisted with a new `user_edit` revision. Driven headlessly
 * with a fake ModelRuntime that returns a canned edited-plan JSON.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Model } from "@earendil-works/pi-ai";
import { capabilityId, planId, taskId } from "@earendil-works/pi-platform/identifier";
import { PlanStore } from "@earendil-works/pi-platform/kernel";
import type { Plan, Task } from "@earendil-works/pi-platform/plan";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { aiEditPlan } from "../src/extensions/plan/index.ts";

const tempDirs: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-plan-ai-edit-"));
	tempDirs.push(root);
	return root;
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});
function task(id: string, title: string): Task {
	return {
		id: taskId(id),
		title,
		purpose: `purpose of ${id}`,
		deliverable: `deliverable-${id}`,
		inputs: [],
		outputs: [],
		dependsOn: [],
		requiredCapabilities: [capabilityId("tool.read")],
		verification: "verify it",
	};
}

function samplePlan(): Plan {
	return {
		id: planId("a"),
		schemaVersion: 1,
		goal: {
			summary: "Build a todo app",
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
		tasks: [task("t1", "Build the todo app")],
		revisions: [{ version: 1, reason: "approval", changedTaskIds: [], createdAt: 1 }],
		status: "approved",
		createdAt: 1,
		updatedAt: 1,
	};
}

describe("aiEditPlan (2.13.5 free-form edit fallback)", () => {
	it("applies a free-form directive via the model and records a user_edit revision", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const base = samplePlan();
		await store.save(base);

		const editedSummary = "This is my to do app";
		// The fake model edits the goal summary and echoes the rest of the plan.
		const editedPlan: Plan = {
			...base,
			goal: { ...base.goal, summary: editedSummary },
		};
		const runtime: ModelRuntime = {
			completeSimple: async (_model: Model<any>, _context: Context) => ({
				role: "assistant" as const,
				content: [{ type: "text" as const, text: JSON.stringify(editedPlan) }],
			}),
		} as unknown as ModelRuntime;
		const fakeModel = { id: "test/model" } as unknown as Model<any>;

		const result = await aiEditPlan({
			plan: base,
			directive: "Add the title at the top",
			store,
			modelRuntime: runtime,
			model: fakeModel,
		});

		// The edit is applied and a new revision is recorded.
		expect(result.goal.summary).toBe(editedSummary);
		expect(result.revisions.length).toBe(2);
		expect(result.revisions[1]).toMatchObject({ version: 2, reason: "user_edit" });

		// The edited plan (with revision) is persisted on disk.
		const loaded = await store.load(base.id);
		expect(loaded.goal.summary).toBe(editedSummary);
		expect(loaded.revisions[1]).toMatchObject({ version: 2, reason: "user_edit" });
	});
});
