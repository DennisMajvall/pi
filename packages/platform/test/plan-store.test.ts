/**
 * Tests for the PlanStore (Step 2.2): workspace-scoped on-disk JSON source of
 * truth, read-through (external edits never drift), full-document revision
 * re-store, and schema validation on save/load.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "../src/error/index.ts";
import { capabilityId, planId, taskId } from "../src/identifier/index.ts";
import { PlanStore } from "../src/kernel/plan-store.ts";
import type { Plan } from "../src/plan/index.ts";

const tempDirs: string[] = [];

function makeWorkspace(plansDirName = "plans"): { root: string; store: PlanStore } {
	const root = mkdtempSync(join(tmpdir(), "pi-platform-plans-"));
	tempDirs.push(root);
	return { root, store: new PlanStore({ rootDir: root, plansDirName }) };
}

function canonicalPlan(id = "plan-a"): Plan {
	return {
		id: planId(id),
		schemaVersion: 1,
		goal: {
			summary: "Ship the billing feature",
			successCriteria: ["Invoices generate on schedule"],
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
		tasks: [
			{
				id: taskId("t1"),
				title: "Generate invoices",
				purpose: "Produce the monthly invoice set",
				deliverable: "invoices",
				inputs: [],
				outputs: ["invoice set"],
				dependsOn: [],
				requiredCapabilities: [capabilityId("tool.write")],
				verification: "Invoices generate on schedule",
			},
		],
		revisions: [],
		status: "draft",
		createdAt: 1700000000000,
		updatedAt: 1700000000000,
	};
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

describe("plan store save/load", () => {
	it("round-trips a plan through save then load", async () => {
		const { store } = makeWorkspace();
		const plan = canonicalPlan();
		await store.save(plan);
		const loaded = await store.load("plan-a");
		expect(loaded).toEqual(plan);
	});

	it("writes one JSON file per plan under the plans directory", async () => {
		const { root, store } = makeWorkspace();
		await store.save(canonicalPlan("alpha"));
		await store.save(canonicalPlan("beta"));
		expect(readdirSync(join(root, "plans")).sort()).toEqual(["alpha.json", "beta.json"]);
		expect(JSON.parse(readFileSync(join(root, "plans", "alpha.json"), "utf8")).id).toBe("alpha");
	});

	it("honours a custom plans directory name", async () => {
		const { root, store } = makeWorkspace("work_plans");
		await store.save(canonicalPlan("gamma"));
		expect(readdirSync(join(root, "work_plans"))).toEqual(["gamma.json"]);
	});

	it("throws NotFoundError when loading a missing plan", async () => {
		const { store } = makeWorkspace();
		await expect(store.load("nope")).rejects.toBeInstanceOf(NotFoundError);
	});

	it("rejects an invalid plan on save", async () => {
		const { store } = makeWorkspace();
		const bad = canonicalPlan();
		(bad as { tasks: unknown[] }).tasks = [{ ...bad.tasks[0]!, status: "done" }];
		await expect(store.save(bad)).rejects.toBeInstanceOf(ValidationError);
	});

	it("rejects invalid on-disk content on load", async () => {
		const { root, store } = makeWorkspace();
		mkdirSync(join(root, "plans"), { recursive: true });
		writeFileSync(join(root, "plans", "broken.json"), JSON.stringify({ id: "broken", schemaVersion: 99 }));
		await expect(store.load("broken")).rejects.toBeInstanceOf(ValidationError);
	});

	it("rejects an unsafe plan id", async () => {
		const { store } = makeWorkspace();
		await expect(store.save({ ...canonicalPlan(), id: planId("../evil") })).rejects.toBeInstanceOf(ValidationError);
		await expect(store.load("../../etc/passwd")).rejects.toBeInstanceOf(ValidationError);
	});
});

describe("read-through (external edits never drift)", () => {
	it("returns the freshest on-disk content after an external edit", async () => {
		const { root, store } = makeWorkspace();
		await store.save(canonicalPlan("plan-a"));
		const edited = canonicalPlan("plan-a");
		edited.goal.summary = "Edited by an editor";
		writeFileSync(join(root, "plans", "plan-a.json"), `${JSON.stringify(edited, null, 2)}\n`);
		const loaded = await store.load("plan-a");
		expect(loaded.goal.summary).toBe("Edited by an editor");
	});

	it("list reflects an externally added plan file", async () => {
		const { root, store } = makeWorkspace();
		await store.save(canonicalPlan("local"));
		writeFileSync(join(root, "plans", "external.json"), `${JSON.stringify(canonicalPlan("external"))}\n`);
		const ids = (await store.list()).map((s) => s.id).sort();
		expect(ids).toEqual(["external", "local"]);
	});
});

describe("plan store list/exists/delete", () => {
	it("lists summaries with metadata and no full documents", async () => {
		const { store } = makeWorkspace();
		await store.save(canonicalPlan("alpha"));
		const summaries = await store.list();
		expect(summaries).toHaveLength(1);
		expect(summaries[0]).toMatchObject({
			id: "alpha",
			status: "draft",
			version: 1,
			taskCount: 1,
			updatedAt: 1700000000000,
		});
		expect(summaries[0]!.modifiedAt).toBeGreaterThan(0);
		expect(summaries[0]).not.toHaveProperty("goal");
	});

	it("exists reflects saved plans", async () => {
		const { store } = makeWorkspace();
		expect(await store.exists("alpha")).toBe(false);
		await store.save(canonicalPlan("alpha"));
		expect(await store.exists("alpha")).toBe(true);
	});

	it("deletes a plan and reports NotFound for a missing one", async () => {
		const { root, store } = makeWorkspace();
		await store.save(canonicalPlan("alpha"));
		await store.delete("alpha");
		expect(readdirSync(join(root, "plans"))).toEqual([]);
		await expect(store.delete("alpha")).rejects.toBeInstanceOf(NotFoundError);
	});
});

describe("revision re-store (§8)", () => {
	it("appends a revision and re-stores the whole document", async () => {
		const { store } = makeWorkspace();
		await store.save(canonicalPlan("alpha"));
		const saved = await store.revise("alpha", "optimizer", [taskId("t1")], (plan) => {
			plan.policy.parallelExecution = false;
		});
		expect(saved.revisions).toEqual([
			{ version: 1, reason: "optimizer", changedTaskIds: ["t1"], createdAt: saved.updatedAt },
		]);
		expect(saved.status).toBe("draft");

		const loaded = await store.load("alpha");
		expect(loaded.revisions).toHaveLength(1);
		expect(loaded.policy.parallelExecution).toBe(false);
		expect(loaded.revisions[0]).toMatchObject({ version: 1, reason: "optimizer", changedTaskIds: ["t1"] });

		// A second revise bumps the version.
		await store.revise("alpha", "user_edit", [taskId("t1")], () => {});
		const reloaded = await store.load("alpha");
		expect(reloaded.revisions.map((r) => r.version)).toEqual([1, 2]);
	});
});
