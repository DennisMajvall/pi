/**
 * Tests for Step 2.13.5: the real-model `/plan` wiring — `createStageCompletion`
 * (a StageCompletion bound to ModelRuntime.completeSimple) and `generatePlan`
 * (binds the seven AI stages + routing → runPlanningPipeline). Driven headlessly
 * with a fake ModelRuntime that returns per-stage canned JSON keyed by the stage
 * system prompt, against a temp-dir PlanStore.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Model } from "@earendil-works/pi-ai";
import { PlanStore } from "@earendil-works/pi-platform/kernel";
import type { Plan } from "@earendil-works/pi-platform/plan";
import { createPlanCapabilityRunner, type StageCompletion } from "@earendil-works/pi-platform/planning";
import { afterEach, describe, expect, it } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { createStageCompletion, generatePlan } from "../src/extensions/plan/index.ts";

const tempDirs: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-plan-cmd-"));
	tempDirs.push(root);
	return root;
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

const fakeEvents = {
	emit: async () => {},
	emitSync: async () => {},
} as unknown as Parameters<typeof generatePlan>[0]["events"];

/** Per-stage canned JSON, keyed by the stage's system prompt. */
function stageJson(systemPrompt: string): string {
	if (systemPrompt.includes("Goal Analysis")) {
		return JSON.stringify({
			summary: "Ship a todo app",
			successCriteria: ["deliverable-t1"],
			unknowns: [],
			requiresClarification: false,
			clarificationQuestions: [],
		});
	}
	if (systemPrompt.includes("Execution Strategy")) {
		return JSON.stringify({
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
		});
	}
	if (systemPrompt.includes("Constraint Extraction")) {
		return JSON.stringify({
			hardConstraints: [],
			softConstraints: [],
			resourceConstraints: [],
			policyConstraints: [],
		});
	}
	if (systemPrompt.includes("Task Decomposition")) {
		return JSON.stringify({
			tasks: [{ id: "t1", title: "Build index.html", purpose: "purpose", deliverable: "deliverable-t1" }],
		});
	}
	if (systemPrompt.includes("Plan Critic")) {
		return JSON.stringify({
			missingTasks: [],
			duplicateTasks: [],
			circularDependencies: [],
			incorrectAssumptions: [],
			risks: [],
			questions: [],
		});
	}
	if (systemPrompt.includes("Plan Metrics assessor")) {
		return JSON.stringify({ completeness: 90, confidence: 70, risk: "low", unknownCount: 0, missingInformation: [] });
	}
	// Optimizer: not grounded here — return non-JSON so the optional stage degrades
	// to the draft (the same behavior as the 2.12 free-model e2e).
	return "not the full plan json";
}

/** A fake model runtime whose completeSimple returns per-stage canned JSON. */
function fakeModelRuntime(): ModelRuntime {
	return {
		completeSimple: async (_model: Model<any>, context: Context) => {
			const json = stageJson(context.systemPrompt ?? "");
			return { role: "assistant" as const, content: [{ type: "text" as const, text: json }] };
		},
	} as unknown as ModelRuntime;
}

const fakeModel = { id: "test/model" } as unknown as Model<any>;

describe("createStageCompletion (2.13.5)", () => {
	it("calls modelRuntime.completeSimple with a system+user context and returns the text", async () => {
		const completion: StageCompletion = createStageCompletion(fakeModelRuntime(), fakeModel);
		const text = await completion({
			systemPrompt: "You are Pi's Goal Analysis module.",
			userPrompt: "<user_request>hi</user_request>",
			model: "test/model",
		});
		expect(() => JSON.parse(text)).not.toThrow();
		const parsed = JSON.parse(text) as { summary: string };
		expect(parsed.summary).toBe("Ship a todo app");
	});
});

describe("generatePlan via a real-model completion (2.13.5)", () => {
	it("runs the pipeline on the session model and persists an approved plan the runner lists", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const plan: Plan = await generatePlan({
			request: "Plan a single-file todo app",
			store,
			events: fakeEvents,
			modelRuntime: fakeModelRuntime(),
			model: fakeModel,
		});

		expect(plan.status).toBe("approved");
		expect(plan.tasks.length).toBe(1);
		expect(plan.tasks[0]?.title).toBe("Build index.html");

		// Persisted on disk and visible through the /plans runner (read-through).
		const loaded = await store.load(plan.id);
		expect(loaded.status).toBe("approved");
		const runner = createPlanCapabilityRunner({ store, events: fakeEvents });
		expect((await runner.list()).map((entry) => entry.id)).toContain(plan.id);
	});
});
