/**
 * End-to-end planning smoke test with a real (free) LLM model.
 *
 * Drives the full planning pipeline (`runPlanningPipeline`) against an OpenRouter
 * free model, then asserts — with static/structural checks, not plan-quality
 * judgment — that a plan was made the correct way:
 *
 *   - a plan in status `approved` that validates against `PlanSchema`;
 *   - every task is well-formed (non-empty title/purpose/deliverable, unique ids,
 *     `dependsOn` only referencing existing tasks);
 *   - the deterministic `validatePlan` passes (schema + acyclicity + coverage) —
 *     i.e. the pipeline produced an internally-consistent plan, not that the plan
 *     is "good";
 *   - the approval revised the plan (`approval` revision) and the plan persisted
 *     to disk (read-through via PlanStore).
 *
 * Verifying "that a plan was made" rather than "that the plan is solid" is the
 * point: an agent-generated plan's *quality* is not deterministically assertable
 * here, but its *structure and lifecycle* are.
 *
 * Skipped unless OPENROUTER_API_KEY is set (CI/offline). The model defaults to the
 * free OpenRouter nemotron model; override with PI_E2E_SMOKE_MODEL. The request is
 * crafted so the plan's success criteria map one-to-one onto task deliverables,
 * which is what lets the pipeline's deterministic coverage check pass.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { PlanStore } from "../src/kernel/plan-store.ts";
import type { Plan } from "../src/plan/index.ts";
import type { StageCompletion, StageModelRouting } from "../src/planning/index.ts";
import {
	constraintExtractionStage,
	criticStage,
	executionStrategyStage,
	goalAnalysisStage,
	metricsStage,
	optimizerStage,
	type PlanningStages,
	runPlanningPipeline,
	taskDecompositionStage,
	validatePlan,
} from "../src/planning/index.ts";
import { PlanSchema } from "../src/schema/plan.ts";
import type { EventBusService } from "../src/service/index.ts";

const MODEL = process.env.PI_E2E_SMOKE_MODEL ?? "nvidia/nemotron-3-ultra-550b-a55b:free";

// A request engineered so a half-decent model emits success criteria that map
// one-to-one onto task deliverables (which is what lets coverage validation pass).
const REQUEST =
	"Create a Node.js library project with exactly three deliverables, in this exact " +
	"order: (1) a package.json manifest, (2) a src/index.ts entry module, (3) a " +
	"test/index.test.ts test suite that passes. The plan's success criteria must be " +
	"exactly: 'package.json', 'src/index.ts', 'test/index.test.ts'. Plan for a short, " +
	"serial task list where each task produces exactly one of those three deliverables " +
	"in that dependency order: package.json first, then src/index.ts, then " +
	"test/index.test.ts.";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
	tempDirs.length = 0;
});

/** Bound `it` so the whole suite skips cleanly when no key is configured. */
const runE2E = process.env.OPENROUTER_API_KEY ? it : it.skip;

/** OpenRouter OpenAI-compatible completion bound to the free model (strict JSON). */
function openRouterCompletion(): StageCompletion {
	return async ({ systemPrompt, userPrompt, model }) => {
		// The free tier is transiently flaky (empty replies, rate limits), so the
		// harness retries like a real client before giving up; the platform runner
		// additionally contains any residual throw as a failed attempt (§11).
		let lastError = "unknown";
		for (let attempt = 0; attempt < 4; attempt++) {
			if (attempt > 0) {
				await sleep(1500 * attempt);
			}
			try {
				const content = await callOnce(systemPrompt, userPrompt, model);
				if (content.trim()) {
					return content;
				}
				lastError = "empty completion";
			} catch (error) {
				lastError = error instanceof Error ? error.message : String(error);
			}
		}
		throw new Error(`OpenRouter failed after retries: ${lastError}`);
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One OpenRouter call; throws on transport/HTTP/empty failures. */
async function callOnce(systemPrompt: string, userPrompt: string, model: string): Promise<string> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 90_000);
	try {
		const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
			method: "POST",
			signal: controller.signal,
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
			},
			body: JSON.stringify({
				model,
				temperature: 0,
				messages: [
					{ role: "system", content: systemPrompt },
					{ role: "user", content: userPrompt },
				],
				response_format: { type: "json_object" },
			}),
		});
		if (!res.ok) {
			const body = await res.text();
			throw new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`);
		}
		const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
		return data.choices?.[0]?.message?.content ?? "";
	} finally {
		clearTimeout(timer);
	}
}

function buildStages(completion: StageCompletion): PlanningStages {
	// All stages use the same free model via the routing default (per-stage
	// overrides are a host concern; here the free model carries the whole smoke).
	const routing: StageModelRouting = { default: MODEL };
	return {
		goal: goalAnalysisStage(completion, routing),
		strategy: executionStrategyStage(completion, routing),
		constraints: constraintExtractionStage(completion, routing),
		tasks: taskDecompositionStage(completion, routing),
		critic: criticStage(completion, routing),
		optimizer: optimizerStage(completion, routing),
		metrics: metricsStage(completion, routing),
	};
}

/** Static/structural checks that a plan was made the correct way. */
function assertPlanMadeCorrectly(plan: Plan): void {
	// Lifecycle: an approved, schema-valid plan.
	expect(plan.status).toBe("approved");
	expect(Value.Check(PlanSchema, plan)).toBe(true);
	expect(plan.revisions.at(-1)?.reason).toBe("approval");

	// The goal was actually understood/formatted (not an empty shell).
	expect(plan.goal.summary.trim().length).toBeGreaterThan(0);

	// A plan was produced, and every task is well-formed with unique ids.
	expect(plan.tasks.length).toBeGreaterThanOrEqual(1);
	const ids = plan.tasks.map((t) => String(t.id));
	expect(new Set(ids).size).toBe(ids.length);
	for (const task of plan.tasks) {
		expect(task.title.trim().length).toBeGreaterThan(0);
		expect(task.purpose.trim().length).toBeGreaterThan(0);
		expect(task.deliverable.trim().length).toBeGreaterThan(0);
	}

	// Dependencies only reference existing tasks (no dangling edges).
	const idSet = new Set(ids);
	for (const task of plan.tasks) {
		for (const dep of task.dependsOn) {
			expect(idSet.has(String(dep))).toBe(true);
		}
	}

	// The determinism gate: schema + acyclicity + coverage all pass, i.e. the
	// pipeline produced an internally-consistent, executable-shaped plan.
	expect(validatePlan(plan).valid).toBe(true);
}

describe("planning e2e with a free model (static structural verification)", () => {
	runE2E(
		"a real free model produces a correctly-formed approved plan, verified structurally",
		{ timeout: 300_000, retry: 1 },
		async () => {
			const root = mkdtempSync(join(tmpdir(), "pi-platform-e2e-"));
			tempDirs.push(root);
			const store = new PlanStore({ rootDir: root });
			let emitted = 0;
			const events = {
				emit: async () => {
					emitted += 1;
				},
				emitSync: async () => {},
			} as unknown as EventBusService;

			const result = await runPlanningPipeline(REQUEST, buildStages(openRouterCompletion()), {
				store,
				events,
			});

			// "Was a plan made in the correct way?" — static checks, not quality.
			assertPlanMadeCorrectly(result.plan);

			// The approved plan is the durable on-disk artifact (read-through).
			const loaded = await store.load(result.plan.id);
			expect(loaded.status).toBe("approved");
			expect(loaded.id).toBe(result.plan.id);

			// The lifecycle events fired (plan.created + plan.approved).
			expect(emitted).toBe(2);
		},
	);
});
