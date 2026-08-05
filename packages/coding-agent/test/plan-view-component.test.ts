/**
 * Tests for Step 2.13.3: the PlanViewComponent pi-tui adapter + the /plans
 * wiring. Drives the component headlessly with real pi-tui key sequences
 * (render + handleInput), asserting the plan list → drill-in → edit → approve
 * flow over a temp-dir plan store — no terminal, no model.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityId, planId, taskId } from "@earendil-works/pi-platform/identifier";
import { PlanStore } from "@earendil-works/pi-platform/kernel";
import type { Plan, Task } from "@earendil-works/pi-platform/plan";
import { createPlanCapabilityRunner, PlanViewWidget } from "@earendil-works/pi-platform/planning";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { PlanViewComponent } from "../src/extensions/plan/plan-view-component.ts";

const tempDirs: string[] = [];

function makeRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-planview-comp-"));
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
		requiredCapabilities: [capabilityId("tool.read")],
		verification: "verify",
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

const fakeEvents = {
	emit: async () => {},
	emitSync: async () => {},
} as unknown as Parameters<typeof createPlanCapabilityRunner>[0]["events"];

function fakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

/** Wait until a condition holds (the component's handleInput is fire-and-forget,
 * and states like entering a plan load from disk asynchronously). */
async function waitFor(pred: () => boolean): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > 2000) throw new Error("timed out waiting for widget state");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	await new Promise((resolve) => setTimeout(resolve, 0)); // let render flush too
}

async function makeComponent(plans: Plan[]): Promise<{ widget: PlanViewWidget; component: PlanViewComponent }> {
	const root = makeRoot();
	const store = new PlanStore({ rootDir: root });
	for (const plan of plans) {
		await store.save(plan);
	}
	const runner = createPlanCapabilityRunner({ store, events: fakeEvents });
	const widget = new PlanViewWidget({ runner });
	await widget.initialize();
	const component = new PlanViewComponent(widget, fakeTui());
	return { widget, component };
}

describe("PlanViewComponent (2.13.3)", () => {
	it("renders the plan list through the pi-tui adapter", async () => {
		const { widget, component } = await makeComponent([samplePlan("a"), samplePlan("b", { status: "needs_review" })]);
		expect(widget.currentMode).toBe("list");
		const lines = component.render(80).join("\n");
		expect(lines).toContain("Ship a");
		expect(lines).toContain("[needs_review]");
	});

	it("maps arrow keys to list navigation", async () => {
		const { widget, component } = await makeComponent([samplePlan("a"), samplePlan("b")]);
		expect(widget.selectedPlanId()).toBe("a");
		component.handleInput("\x1bOB");
		await waitFor(() => widget.selectedPlanId() === "b");
		expect(component.render(80).join("\n")).toContain("> b");
		component.handleInput("\x1bOA");
		await waitFor(() => widget.selectedPlanId() === "a");
	});

	it("maps enter to drill into a plan", async () => {
		const { widget, component } = await makeComponent([samplePlan("a")]);
		component.handleInput("\r");
		await waitFor(() => widget.currentMode === "detail");
		expect(component.render(80).join("\n")).toContain("Requirement: Ship a");
	});

	it("approves a needs_review plan on 'a' and re-renders the new status", async () => {
		const { widget, component } = await makeComponent([samplePlan("a", { status: "needs_review" })]);
		component.handleInput("\r");
		await waitFor(() => widget.currentMode === "detail");
		expect(component.render(80).join("\n")).toContain("[needs_review]");
		component.handleInput("a");
		await waitFor(() => widget.currentPlan?.status === "approved");
		expect(component.render(80).join("\n")).toContain("[approved]");
	});

	it("edits via 'e' + typed directive (mode-aware so 'a'/'r' type, not act)", async () => {
		const { widget, component } = await makeComponent([samplePlan("a")]);
		component.handleInput("\r");
		await waitFor(() => widget.currentMode === "detail");
		component.handleInput("e"); // begin editing
		await waitFor(() => widget.currentMode === "editing");
		for (const ch of "rename t1 to Backend") {
			component.handleInput(ch); // in editing mode these are buffer chars (incl. 'a'/'r'/'e')
		}
		component.handleInput("\r"); // submit
		await waitFor(() => widget.currentPlan?.tasks.find((t) => String(t.id) === "t1")?.title === "Backend");
		expect(widget.currentMode).toBe("detail"); // 'e'/'r'/'a' typed as chars did not fire actions
	});

	it("escape backs out: detail → list, then list → onClose", async () => {
		let closed = 0;
		const root = makeRoot();
		const store = new PlanStore({ rootDir: root });
		await store.save(samplePlan("a"));
		const runner = createPlanCapabilityRunner({ store, events: fakeEvents });
		const widget = new PlanViewWidget({
			runner,
			onClose: () => {
				closed += 1;
			},
		});
		await widget.initialize();
		const component = new PlanViewComponent(widget, fakeTui());

		component.handleInput("\r");
		await waitFor(() => widget.currentMode === "detail");
		component.handleInput("\x1b");
		await waitFor(() => widget.currentMode === "list");
		component.handleInput("\x1b");
		await waitFor(() => closed === 1);
	});
});
