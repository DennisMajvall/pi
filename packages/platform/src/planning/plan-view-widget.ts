/**
 * Plan View widget controller (Step 2.13.2).
 *
 * The interactive plan review surface as a pure, headless state machine +
 * renderer, driving the `PlanCapabilityRunner` (2.13.1): a plan list scaffolds
 * drill-in to a selected plan; within the detail view a selectable task list
 * surfaces the selected task's detail; an edit directive is collected and routed
 * through `user_edit` (via the runner); an explicit approve flips `needs_review →
 * approved`. Read-through guarantees freshness at every render/navigation/action,
 * with a manual refresh; no change-watching (deferred to roadmap #4).
 *
 * This module has no terminal/model dependency: it implements
 * `render(width): string[]` + semantic `handle(action)` and is driven by a thin
 * key/component adapter (the live TUI adapter is 2.13.3) or directly by tests.
 */

import type { Plan, Task } from "../plan/index.ts";
import type { PlanCapabilityRunner, PlanListEntry } from "./plan-capability.ts";
import { renderPlanDag } from "./plan-view.ts";

/** A semantic action the widget handles (a key/component adapter maps keys to these). */
export type PlanViewAction =
	| { type: "up" }
	| { type: "down" }
	| { type: "enter" }
	| { type: "escape" }
	| { type: "approve" }
	| { type: "edit" }
	| { type: "char"; char: string }
	| { type: "backspace" }
	| { type: "refresh" };

/** Which screen the widget is showing. */
export type PlanViewMode = "list" | "detail" | "editing";

/** Options for constructing the widget. */
export interface PlanViewWidgetOptions {
	runner: PlanCapabilityRunner;
	/** Called when the user backs out of the top-level plan list (returns to chat). */
	onClose?: () => void;
}

/** Render the detail lines for one task (purpose/deliverable/deps/verification). */
export function renderTaskDetail(task: Task): string[] {
	return [
		`Purpose: ${task.purpose}`,
		`Deliverable: ${task.deliverable}`,
		`Depends on: ${task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "(none)"}`,
		`Requires: ${task.requiredCapabilities.length > 0 ? task.requiredCapabilities.join(", ") : "(none)"}`,
		`Verification: ${task.verification.trim().length > 0 ? task.verification : "(none)"}`,
	];
}

/** A pure plan-list + plan-detail + edit-directive controller. */
export class PlanViewWidget {
	private readonly runner: PlanCapabilityRunner;
	private readonly onClose?: () => void;

	private entries: PlanListEntry[] = [];
	private selectedIndex = 0;
	private mode: PlanViewMode = "list";
	private plan: Plan | undefined;
	private selectedTaskIndex = 0;
	private editBuffer = "";
	private error: string | undefined;

	constructor(options: PlanViewWidgetOptions) {
		this.runner = options.runner;
		this.onClose = options.onClose;
	}

	/** Current screen. */
	get currentMode(): PlanViewMode {
		return this.mode;
	}

	/** The loaded plan in detail mode (undefined in list / before a plan is opened). */
	get currentPlan(): Plan | undefined {
		return this.plan;
	}

	/** The selected plan id (list mode), or the open plan's id (detail mode). */
	selectedPlanId(): string | undefined {
		if (this.mode === "list") {
			return this.entries[this.selectedIndex]?.id;
		}
		return this.plan?.id ? String(this.plan.id) : undefined;
	}

	/** Load the plan list (fresh from disk) — the widget's entry action. */
	async initialize(): Promise<void> {
		await this.reloadList();
	}

	/** Re-read the plan list / open plan (read-through freshness). */
	async refresh(): Promise<void> {
		if (this.mode === "detail" || this.mode === "editing") {
			if (this.plan) {
				this.plan = await this.runner.load(String(this.plan.id));
			}
			await this.reloadList();
		} else {
			await this.reloadList();
		}
		this.error = undefined;
	}

	/** Handle a semantic action. Returns the widget (for chaining/tests). */
	async handle(action: PlanViewAction): Promise<void> {
		switch (action.type) {
			case "up":
				this.moveUp();
				break;
			case "down":
				this.moveDown();
				break;
			case "enter":
				await this.enter();
				break;
			case "escape":
				this.escape();
				break;
			case "approve":
				await this.approve();
				break;
			case "edit":
				this.beginEdit();
				break;
			case "char":
				if (this.mode === "editing") {
					this.editBuffer += action.char;
				}
				break;
			case "backspace":
				if (this.mode === "editing") {
					this.editBuffer = this.editBuffer.slice(0, -1);
				}
				break;
			case "refresh":
				await this.refresh();
				break;
		}
	}

	private moveUp(): void {
		if (this.mode === "list") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
		} else if (this.mode === "detail" && this.plan) {
			this.selectedTaskIndex = Math.max(0, this.selectedTaskIndex - 1);
		}
	}

	private moveDown(): void {
		if (this.mode === "list") {
			this.selectedIndex = Math.min(this.entries.length - 1, this.selectedIndex + 1);
		} else if (this.mode === "detail" && this.plan) {
			this.selectedTaskIndex = Math.min(this.plan.tasks.length - 1, this.selectedTaskIndex + 1);
		}
	}

	private async enter(): Promise<void> {
		if (this.mode === "list") {
			const id = this.selectedPlanId();
			if (id === undefined) {
				return;
			}
			try {
				this.plan = await this.runner.load(id);
				this.selectedTaskIndex = 0;
				this.mode = "detail";
				this.error = undefined;
			} catch (error) {
				this.error = toErrorMessage(error);
			}
		} else if (this.mode === "editing") {
			await this.submitEdit();
		}
	}

	private escape(): void {
		if (this.mode === "editing") {
			this.mode = "detail";
			this.editBuffer = "";
		} else if (this.mode === "detail") {
			this.mode = "list";
			this.plan = undefined;
			this.selectedTaskIndex = 0;
			void this.reloadList();
		} else {
			this.onClose?.();
		}
	}

	private async approve(): Promise<void> {
		if (this.mode !== "detail" || !this.plan) {
			return;
		}
		try {
			this.plan = await this.runner.review(String(this.plan.id), "approve");
			this.error = undefined;
		} catch (error) {
			this.error = toErrorMessage(error);
		}
	}

	private beginEdit(): void {
		if (this.mode !== "detail") {
			return;
		}
		this.editBuffer = "";
		this.mode = "editing";
		this.error = undefined;
	}

	private async submitEdit(): Promise<void> {
		const directive = this.editBuffer.trim();
		this.mode = "detail";
		this.editBuffer = "";
		if (directive.length === 0 || !this.plan) {
			return;
		}
		try {
			this.plan = await this.runner.edit(String(this.plan.id), directive);
			this.error = undefined;
		} catch (error) {
			this.error = toErrorMessage(error);
		}
	}

	private async reloadList(): Promise<void> {
		this.entries = await this.runner.list();
		if (this.entries.length === 0) {
			this.selectedIndex = 0;
		} else if (this.selectedIndex >= this.entries.length) {
			this.selectedIndex = this.entries.length - 1;
		}
	}

	/** Render the current screen as plain lines (each ≤ `width`). */
	render(width: number): string[] {
		if (this.mode === "detail" && this.plan) {
			return this.renderDetail(width);
		}
		if (this.mode === "editing" && this.plan) {
			return this.renderEditing(width);
		}
		return this.renderList(width);
	}

	private renderList(width: number): string[] {
		const lines: string[] = [`# Plans (${this.entries.length})`, ""];
		if (this.entries.length === 0) {
			lines.push("No plans yet. Create one with /plan <request>.");
		} else {
			for (let i = 0; i < this.entries.length; i++) {
				const entry = this.entries[i]!;
				const marker = i === this.selectedIndex ? "> " : "  ";
				const metrics = entry.metrics ? `  ${entry.metrics}` : "";
				lines.push(
					truncate(
						`${marker}${entry.id}  ${entry.title}  [${entry.status}] (v${entry.version})  ${entry.taskCount} tasks${metrics}`,
						width,
					),
				);
			}
		}
		if (this.error) {
			lines.push("", `error: ${this.error}`);
		}
		lines.push(
			"",
			this.entries.length > 0
				? "[up/down navigate · enter open · escape quit · r refresh]"
				: "[escape quit · r refresh]",
		);
		return lines;
	}

	private renderDetail(width: number): string[] {
		const plan = this.plan!;
		const version = plan.revisions.length > 0 ? plan.revisions[plan.revisions.length - 1]!.version : 1;
		const diff = this.error ? `  error: ${this.error}` : "";
		const head = `# Plan ${plan.id}  [${plan.status}] (v${version})${diff}`;
		const requirement = `Requirement: ${plan.goal.summary}`;
		const tasksLeft =
			plan.tasks.length > 0
				? plan.tasks.map((t, i) => {
						const marker = i === this.selectedTaskIndex ? "> " : "  ";
						const deps = t.dependsOn.length > 0 ? `  (after ${t.dependsOn.join(",")})` : "";
						return `${marker}${t.id}  ${t.title}${deps}`;
					})
				: ["(no tasks)"];
		const selectedTask = plan.tasks[this.selectedTaskIndex];
		const taskRight = selectedTask
			? [`## ${selectedTask.id}  ${selectedTask.title}`, ...renderTaskDetail(selectedTask)]
			: ["(select a task)"];

		const appRows = twoPane(tasksLeft, taskRight, width);
		const dag = renderPlanDag(plan).split("\n");
		const hints =
			plan.status === "needs_review"
				? "[up/down task · a approve · e edit · escape back]"
				: "[up/down task · e edit · escape back]";
		return [
			truncate(head, width),
			truncate(requirement, width),
			"",
			...appRows,
			"",
			...dag.map((l) => truncate(l, width)),
			"",
			hints,
		];
	}

	private renderEditing(width: number): string[] {
		const plan = this.plan!;
		const version = plan.revisions.length > 0 ? plan.revisions[plan.revisions.length - 1]!.version : 1;
		const head = `# Plan ${plan.id}  [${plan.status}] (v${version})`;
		const prompt = `edit > ${this.editBuffer}${this.editBuffer.length > 0 ? "" : " "}`;
		const hint = "[type a directive like 'merge t2 and t3' · enter apply · escape cancel]";
		return [
			truncate(head, width),
			truncate(plan.goal.summary, width),
			"",
			truncate(prompt, width),
			"",
			this.error ? truncate(`error: ${this.error}`, width) : hint,
		];
	}
}

/** Left/right two-pane join, each row truncated to `width`. */
function twoPane(left: string[], right: string[], width: number): string[] {
	const half = Math.floor(width / 2);
	const rows = Math.max(left.length, right.length);
	const out: string[] = [];
	for (let i = 0; i < rows; i++) {
		const l = truncate(left[i] ?? "", half);
		const r = truncate(right[i] ?? "", width - half - 1);
		out.push(`${l.padEnd(half)}${r.length > 0 ? "│" : " "}${r}`);
	}
	return out;
}

function truncate(text: string, width: number): string {
	return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
