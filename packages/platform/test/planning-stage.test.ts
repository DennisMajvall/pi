/**
 * Tests for the planning capability skeleton (Step 2.3): the shared strict-JSON
 * stage runner (§11 retry/degrade), per-stage model routing, and the end-to-end
 * walking skeleton — a trivial `orchestration` capability registered in a
 * kernel runtime, persisting through the PlanStore and emitting `plan.created`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { capabilityId } from "../src/identifier/index.ts";
import { NodeFileSystemService } from "../src/kernel/fs-service.ts";
import { createRuntime, type KernelRuntime } from "../src/kernel/index.ts";
import { PlanStore } from "../src/kernel/plan-store.ts";
import { EVENT_PLAN_CREATED } from "../src/planning/events.ts";
import {
	DEFAULT_STAGE_MODEL_ROUTING,
	definePlanningStageCapability,
	type PlanningStageExport,
	resolveStageModel,
	runStrictJsonStage,
	type StageCompletion,
} from "../src/planning/index.ts";
import { createDraftPlanStage } from "../src/planning/trivial.ts";

const tempDirs: string[] = [];

function makeWorkspace(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-platform-planning-"));
	tempDirs.push(root);
	return root;
}

/** A completion that returns the given texts in sequence, then fails. */
function sequenceCompletion(...texts: string[]): StageCompletion {
	let index = 0;
	return async () => texts[Math.min(index++, texts.length - 1)]!;
}

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

const pointSchema = Type.Object({ x: Type.Number(), y: Type.Number() });

describe("strict-JSON stage runner (§11)", () => {
	it("returns valid output on the first attempt", async () => {
		const result = await runStrictJsonStage({
			completion: sequenceCompletion(JSON.stringify({ x: 1, y: 2 })),
			systemPrompt: "sys",
			userPrompt: "user",
			outputSchema: pointSchema,
			model: "m",
			mandatory: true,
		});
		expect(result).toEqual({ kind: "ok", output: { x: 1, y: 2 }, attempts: 1 });
	});

	it("retries once with validation feedback when the first attempt is invalid", async () => {
		const seen: string[] = [];
		const completion: StageCompletion = async ({ userPrompt }) => {
			seen.push(userPrompt);
			return seen.length === 1 ? JSON.stringify({ x: "nope" }) : JSON.stringify({ x: 3, y: 4 });
		};
		const result = await runStrictJsonStage({
			completion,
			systemPrompt: "sys",
			userPrompt: "user",
			outputSchema: pointSchema,
			model: "m",
			mandatory: true,
		});
		expect(result).toEqual({ kind: "ok", output: { x: 3, y: 4 }, attempts: 2 });
		expect(seen[1]).toContain("failed validation");
	});

	it("aborts a mandatory stage after two invalid attempts with a diagnostic", async () => {
		const result = await runStrictJsonStage({
			completion: sequenceCompletion(JSON.stringify({ x: "bad" })),
			systemPrompt: "sys",
			userPrompt: "user",
			outputSchema: pointSchema,
			model: "m",
			mandatory: true,
			stageName: "goal_analysis",
		});
		expect(result.kind).toBe("aborted");
		if (result.kind === "aborted") {
			expect(result.error).toContain("goal_analysis");
			expect(result.error).toContain("failed validation");
			expect(result.attempts).toBe(2);
		}
	});

	it("degrades (skips) an optional stage after two invalid attempts", async () => {
		const result = await runStrictJsonStage({
			completion: sequenceCompletion("not json at all"),
			systemPrompt: "sys",
			userPrompt: "user",
			outputSchema: pointSchema,
			model: "m",
			mandatory: false,
			stageName: "critic",
		});
		expect(result.kind).toBe("degraded");
		if (result.kind === "degraded") {
			expect(result.error).toContain("critic");
		}
	});

	it("parses a markdown-fenced JSON response", async () => {
		const result = await runStrictJsonStage({
			completion: sequenceCompletion('```json\n{"x": 5, "y": 6}\n```'),
			systemPrompt: "sys",
			userPrompt: "user",
			outputSchema: pointSchema,
			model: "m",
			mandatory: true,
		});
		expect(result).toEqual({ kind: "ok", output: { x: 5, y: 6 }, attempts: 1 });
	});
});

describe("per-stage model routing", () => {
	it("uses the per-stage override, independent of the session model", () => {
		const routing = { ...DEFAULT_STAGE_MODEL_ROUTING, stages: { "orchestration.goal": "cheap-1" } };
		expect(resolveStageModel("orchestration.goal", routing)).toBe("cheap-1");
		expect(resolveStageModel("orchestration.decompose", routing)).toBe("");
	});

	it("uses the default when no override exists", () => {
		expect(resolveStageModel("orchestration.decompose", { default: "capable-1", stages: {} })).toBe("capable-1");
	});
});

describe("walking skeleton: trivial stage end-to-end", () => {
	it("runs as an orchestration capability, persists via the store, and emits plan.created", async () => {
		const root = makeWorkspace();
		const runtime: KernelRuntime = createRuntime({
			builtins: [definePlanningStageCapability(createDraftPlanStage)],
			services: { fs: new NodeFileSystemService(root) },
		});
		await runtime.initialize();
		await runtime.start();

		const emitted: string[] = [];
		runtime.events.subscribeAll((event) => {
			emitted.push(event.type);
		});

		const exports = runtime.capabilities.getExports<{ stage: PlanningStageExport }>(
			capabilityId("orchestration.plan.create"),
		);
		expect(exports).toBeDefined();
		if (!exports) {
			throw new Error("stage export missing");
		}

		const output = await exports.stage.run({ id: "plan-1", summary: "Ship the billing feature" });

		// plan.created emitted on the shared bus.
		expect(emitted).toContain(EVENT_PLAN_CREATED);

		// Persisted on disk and readable back through a fresh PlanStore.
		const store = new PlanStore({ rootDir: root });
		const loaded = await store.load("plan-1");
		expect(loaded.goal.summary).toBe("Ship the billing feature");
		expect(loaded.status).toBe("draft");
		expect(loaded).toEqual(output);

		// The stage is a real orchestration capability in the registry.
		const info = runtime.capabilities.get(capabilityId("orchestration.plan.create"));
		expect(info?.manifest.category).toBe("orchestration");
		expect(info?.state).toBe("ready");

		await runtime.shutdown();
	});
});
