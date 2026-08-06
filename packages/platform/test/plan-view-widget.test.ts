/**
 * Tests for Step 2.13.2: the PlanView widget controller — a pure, headless
 * plan-list → drill-in → task-detail → edit-directive → approve surface driving
 * the PlanCapabilityRunner. Driven by semantic actions and rendered to plain
 * lines, so the whole interactive flow is testable without a terminal/model.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capabilityId, planId, taskId } from "../src/identifier/index.ts";
import { PlanStore } from "../src/kernel/plan-store.ts";
import type { Plan, Task } from "../src/plan/index.ts";
import { createPlanCapabilityRunner, type PlanCapabilityRunner, PlanViewWidget } from "../src/planning/index.ts";
import type { EventBusService } from "../src/service/index.ts";

const tempDirs: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-platform-widget-"));
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
		purpose: `purpose of ${id}`,
		deliverable: `deliverable-${id}`,
		inputs: [],
		outputs: [],
		dependsOn: [],
		requiredCapabilities: [capabilityId("tool.read"), capabilityId("command.bash")],
		verification: "verify it",
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
		tasks: [task("t1"), task("t2", { dependsOn: [taskId("t1")] })],
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

async function makeWidget(root: string, plans: Plan[]): Promise<PlanViewWidget> {
	const store = new PlanStore({ rootDir: root });
	for (const plan of plans) {
		await store.save(plan);
	}
	const runner = createPlanCapabilityRunner({ store, events: fakeEvents() });
	const widget = new PlanViewWidget({ runner });
	await widget.initialize();
	return widget;
}

describe("plan list screen (2.13.2)", () => {
	it("lists plans with title/status/version and highlights the selection", async () => {
		const root = makeRoot();
		const widget = await makeWidget(root, [samplePlan("a"), samplePlan("b", { status: "needs_review" })]);
		const lines = widget.render(80).join("\n");
		expect(lines).toContain("Ship a");
		expect(lines).toContain("[needs_review]");
		expect(lines).toContain("> a"); // selected is the first entry
	});

	it("navigates the list with up/down", async () => {
		const root = makeRoot();
		const widget = await makeWidget(root, [samplePlan("a"), samplePlan("b")]);
		expect(widget.selectedPlanId()).toBe("a");
		await widget.handle({ type: "down" });
		expect(widget.selectedPlanId()).toBe("b");
		await widget.handle({ type: "up" });
		expect(widget.selectedPlanId()).toBe("a");
	});

	it("backing out of the list fires onClose", async () => {
		const root = makeRoot();
		let closed = 0;
		const store = new PlanStore({ rootDir: root });
		await store.save(samplePlan("a"));
		const runner = createPlanCapabilityRunner({ store, events: fakeEvents() });
		const widget = new PlanViewWidget({
			runner,
			onClose: () => {
				closed += 1;
			},
		});
		await widget.initialize();
		await widget.handle({ type: "escape" });
		expect(closed).toBe(1);
	});
});

describe("detail screen (2.13.2)", () => {
	it("opens a plan into detail showing requirement, tasks, and selected task detail", async () => {
		const root = makeRoot();
		const widget = await makeWidget(root, [samplePlan("a")]);
		await widget.handle({ type: "enter" });
		expect(widget.currentMode).toBe("detail");
		const lines = widget.render(80).join("\n");
		expect(lines).toContain("# Plan a");
		expect(lines).toContain("Requirement: Ship a");
		expect(lines).toContain("> t1"); // first task selected in the left pane
		expect(lines).toContain("purpose of t1"); // its detail in the right pane
	});

	it("moves the task selection and updates the detail pane", async () => {
		const root = makeRoot();
		const widget = await makeWidget(root, [samplePlan("a")]);
		await widget.handle({ type: "enter" });
		await widget.handle({ type: "down" });
		const lines = widget.render(80).join("\n");
		expect(lines).toContain("> t2");
		expect(lines).toContain("purpose of t2");
		expect(lines).toContain("Requires: tool.read, command.bash");
	});

	it("escape returns from detail to the list (re-listing via read-through)", async () => {
		const root = makeRoot();
		const widget = await makeWidget(root, [samplePlan("a")]);
		await widget.handle({ type: "enter" });
		expect(widget.currentMode).toBe("detail");
		await widget.handle({ type: "escape" });
		expect(widget.currentMode).toBe("list");
		expect(widget.currentPlan).toBeUndefined();
	});
});

describe("approve + edit via the widget (2.13.2)", () => {
	it("approve flips a needs_review plan to approved (read-through)", async () => {
		const root = makeRoot();
		const widget = await makeWidget(root, [samplePlan("a", { status: "needs_review" })]);
		await widget.handle({ type: "enter" });
		expect(widget.render(80).join("\n")).toContain("[needs_review]");
		await widget.handle({ type: "approve" });
		expect(widget.currentPlan?.status).toBe("approved");
		expect(widget.currentMode).toBe("detail");
	});

	it("editing collects a directive and applies it schema-preserving on submit", async () => {
		const root = makeRoot();
		const widget = await makeWidget(root, [samplePlan("a")]);
		await widget.handle({ type: "enter" });
		await widget.handle({ type: "edit" });
		expect(widget.currentMode).toBe("editing");
		for (const ch of "rename t1 to Bootstrap") {
			await widget.handle({ type: "char", char: ch });
		}
		await widget.handle({ type: "enter" });
		expect(widget.currentMode).toBe("detail");
		expect(widget.currentPlan?.tasks.find((t) => String(t.id) === "t1")?.title).toBe("Bootstrap");
	});

	it("escape cancels editing without applying, letting the directive persist in the buffer only", async () => {
		const root = makeRoot();
		const widget = await makeWidget(root, [samplePlan("a")]);
		await widget.handle({ type: "enter" });
		await widget.handle({ type: "edit" });
		for (const ch of "merge t1 and t2") {
			await widget.handle({ type: "char", char: ch });
		}
		await widget.handle({ type: "escape" });
		expect(widget.currentMode).toBe("detail");
		// Nothing was applied: the task set is unchanged.
		expect(widget.currentPlan?.tasks.map((t) => String(t.id))).toEqual(["t1", "t2"]);
	});

	it("a rejected edit (cycle) surfaces an error and keeps the plan editable", async () => {
		const root = makeRoot();
		const widget = await makeWidget(root, [samplePlan("a")]);
		await widget.handle({ type: "enter" });
		await widget.handle({ type: "edit" });
		// t2 depends on t1; making t1 depend on t2 would cycle → rejected.
		for (const ch of "move t1 after t2") {
			await widget.handle({ type: "char", char: ch });
		}
		await widget.handle({ type: "enter" });
		expect(widget.currentMode).toBe("detail");
		// The head line shows the rejected-edit error (truncated at width), and the
		// plan is unchanged: the cycle-inducing move was rejected, not applied.
		expect(widget.render(80).join("\n")).toMatch(/error:/i);
		expect(widget.currentPlan?.tasks.find((t) => String(t.id) === "t1")?.dependsOn).toEqual([]);
	});
});

describe("pending-edit status", () => {
	it("shows a status line while an edit directive is being applied", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		await store.save(samplePlan("a"));
		const base = createPlanCapabilityRunner({ store, events: fakeEvents() });
		let resolveEdit!: (plan: Plan) => void;
		const deferred = new Promise<Plan>((resolve) => {
			resolveEdit = resolve;
		});
		const runner: PlanCapabilityRunner = {
			...base,
			edit: async () => deferred,
		};
		const widget = new PlanViewWidget({ runner });
		await widget.initialize();
		await widget.handle({ type: "enter" }); // open the plan into detail
		await widget.handle({ type: "edit" });
		for (const ch of "add a constraint on local storage") {
			await widget.handle({ type: "char", char: ch });
		}
		// Submit the directive without awaiting so the edit is still in flight.
		const submitting = widget.handle({ type: "enter" });
		expect(widget.isEditPending()).toBe(true);
		expect(widget.render(80).join("\n")).toContain("Applying edit");
		resolveEdit({ ...samplePlan("a") });
		await submitting;
		expect(widget.isEditPending()).toBe(false);
		expect(widget.render(80).join("\n")).not.toContain("Applying edit");
	});
});

describe("freshness (2.13.2)", () => {
	it("refresh() re-reads an externally-edited plan via read-through", async () => {
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		const plan = samplePlan("a");
		await store.save(plan);
		const runner = createPlanCapabilityRunner({ store, events: fakeEvents() });
		const widget = new PlanViewWidget({ runner });
		await widget.initialize();

		// External editor adds a constraint directly on disk.
		await store.save({ ...plan, constraints: [{ kind: "hard", description: "No cloud" }] });

		await widget.handle({ type: "enter" });
		await widget.handle({ type: "refresh" });
		expect(widget.currentPlan?.constraints).toEqual([{ kind: "hard", description: "No cloud" }]);
	});
});
