import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { capabilityId, planId, taskId } from "../src/identifier/index.ts";
import type { Plan } from "../src/plan/index.ts";
import { GoalSchema, PlanSchema, TaskSchema } from "../src/schema/plan.ts";

/** A canonical plan fixture that satisfies every field of PlanSchema. */
function canonicalPlan(): Plan {
	return {
		id: planId("plan-1"),
		schemaVersion: 1,
		goal: {
			summary: "Add a JWT auth middleware to the API gateway",
			successCriteria: [
				"Requests without a valid token are rejected with 401",
				"Valid tokens are accepted and forwarded with identity claims",
			],
			unknowns: ["Token signing secret rotation policy"],
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
			verificationLevel: "strict",
			preferResearch: false,
			maxTasks: 8,
			dualPlanner: false,
		},
		constraints: [
			{ kind: "hard", description: "Must integrate with the existing gateway config schema" },
			{ kind: "policy", description: "Signing keys live in the secrets store, never in source" },
		],
		assumptions: [{ statement: "OpenID discovery endpoints are reachable", confidence: 80, source: "inferred" }],
		tasks: [
			{
				id: taskId("t1"),
				title: "Define token validation contract",
				purpose: "Establish the validation interface before implementation",
				deliverable: "validation contract doc",
				inputs: ["gateway config schema"],
				outputs: ["validation contract"],
				dependsOn: [],
				requiredCapabilities: [capabilityId("tool.read"), capabilityId("tool.write")],
				verification: "Contract reviewed against existing gateway config schema",
			},
			{
				id: taskId("t2"),
				title: "Implement middleware handler",
				purpose: "Validate tokens and attach identity claims",
				deliverable: "auth middleware handler",
				inputs: ["validation contract"],
				outputs: ["auth middleware"],
				dependsOn: [taskId("t1")],
				requiredCapabilities: [capabilityId("tool.write"), capabilityId("command.bash")],
				verification: "Unit tests pass with valid and invalid tokens",
			},
		],
		revisions: [{ version: 1, reason: "user_edit", changedTaskIds: [taskId("t1")], createdAt: 1700000000000 }],
		status: "needs_review",
		metrics: {
			completeness: 100,
			confidence: 75,
			parallelism: 60,
			risk: "medium",
			unknownCount: 1,
			missingInformation: [],
		},
		createdAt: 1700000000000,
		updatedAt: 1700000000000,
	};
}

/** A mutable, untyped clone for negative-validation fixtures. */
function mutablePlan(): Record<string, unknown> {
	return JSON.parse(JSON.stringify(canonicalPlan())) as Record<string, unknown>;
}

describe("plan object schemas", () => {
	it("validates a canonical plan", () => {
		expect(Value.Check(PlanSchema, canonicalPlan())).toBe(true);
	});

	it("round-trips through JSON without losing validity", () => {
		const roundTripped = JSON.parse(JSON.stringify(canonicalPlan()));
		expect(Value.Check(PlanSchema, roundTripped)).toBe(true);
	});

	it("metrics is optional", () => {
		const plan = canonicalPlan();
		delete plan.metrics;
		expect(Value.Check(PlanSchema, plan)).toBe(true);
	});

	it("accepts every status", () => {
		for (const status of [
			"draft",
			"needs_review",
			"approved",
			"running",
			"replanning",
			"completed",
			"failed",
			"archived",
		] as const) {
			const plan = canonicalPlan();
			plan.status = status;
			expect(Value.Check(PlanSchema, plan), status).toBe(true);
		}
	});

	it("accepts every revision reason", () => {
		for (const reason of ["user_edit", "critic", "optimizer", "replan", "approval"] as const) {
			const plan = canonicalPlan();
			plan.revisions = [{ version: 1, reason, changedTaskIds: [taskId("t1")], createdAt: 1 }];
			expect(Value.Check(PlanSchema, plan), reason).toBe(true);
		}
	});

	it("rejects an unknown status", () => {
		const plan = mutablePlan();
		plan.status = "executing";
		expect(Value.Check(PlanSchema, plan)).toBe(false);
	});

	it("rejects an unknown revision reason", () => {
		const plan = mutablePlan();
		(plan.revisions as Record<string, unknown>[])[0]!.reason = "user_edit2";
		expect(Value.Check(PlanSchema, plan)).toBe(false);
	});

	it("rejects a schemaVersion other than 1", () => {
		const plan = mutablePlan();
		plan.schemaVersion = 2;
		expect(Value.Check(PlanSchema, plan)).toBe(false);
	});
});

describe("plan content vs execution state split (§5)", () => {
	it("rejects a task carrying execution state", () => {
		const withStatus = {
			...canonicalPlan().tasks[0]!,
			status: "done",
			priority: 3,
			responsibleAgent: "agent-a",
		};
		expect(Value.Check(TaskSchema, withStatus)).toBe(false);
	});

	it("rejects a task with any unknown field", () => {
		const withExtra = { ...canonicalPlan().tasks[0]!, estimatedEffort: "2d" };
		expect(Value.Check(TaskSchema, withExtra)).toBe(false);
	});
});

describe("task invariants", () => {
	it("validates the task fixture on its own", () => {
		expect(Value.Check(TaskSchema, canonicalPlan().tasks[0]!)).toBe(true);
	});

	it("rejects a requiredCapabilities id that is not a platform capability id", () => {
		const task = canonicalPlan().tasks[0]!;
		expect(Value.Check(TaskSchema, { ...task, requiredCapabilities: ["write files"] })).toBe(false);
		expect(Value.Check(TaskSchema, { ...task, requiredCapabilities: ["read"] })).toBe(false);
	});

	it("accepts namespaced capability ids", () => {
		const task = canonicalPlan().tasks[0]!;
		expect(Value.Check(TaskSchema, { ...task, requiredCapabilities: [capabilityId("tool.read")] })).toBe(true);
	});
});

describe("goal invariants", () => {
	it("rejects a clarification question missing the blocking flag", () => {
		const goal = {
			...canonicalPlan().goal,
			requiresClarification: true,
			clarificationQuestions: [{ question: "Which environment?" }],
		};
		expect(Value.Check(GoalSchema, goal)).toBe(false);
	});
});
