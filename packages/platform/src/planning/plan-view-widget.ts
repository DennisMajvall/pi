/**
 * Plan View widget controller (Step 2.13.2).
 *
 * The interactive plan review surface as a pure, headless state machine +
 * renderer, driving the `PlanCapabilityRunner` (2.13.1): a plan list scaffolds
 * drill-in to a selected plan; within the detail view the whole plan is rendered
 * as a single, word-wrapped document spanning the full terminal width — every
 * section (goal, strategy, constraints, assumptions, tasks, DAG, revisions) is
 * printed in full and the host terminal's scrollback is used to read it, so
 * nothing is truncated or forced into a cramped pane. A selectable task marks
 * the focus for edits; an edit directive is collected and routed through
 * `user_edit` (via the runner); an explicit approve flips `needs_review →
 * approved`. Read-through guarantees freshness at every render/navigation/action,
 * with a manual refresh; no change-watching (deferred to roadmap #4).
 *
 * This module has no terminal/model dependency: it implements
 * `render(width): string[]` + semantic `handle(action)` and is driven by a thin
 * key/component adapter (the live TUI adapter is 2.13.3) or directly by tests.
 */

import type { Plan, Task } from "../plan/index.ts";
import type { PlanCapabilityRunner, PlanListEntry } from "./plan-capability.ts";
import { renderPlanDag, renderRevisionHistory } from "./plan-view.ts";

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

	/**
	 * Detail view: the whole plan as one word-wrapped document spanning the full
	 * terminal width. Every section is printed in full (goal, strategy,
	 * constraints, assumptions, tasks, DAG, revisions) so the terminal's
	 * scrollback can be used to read it rather than truncating long prose. The
	 * selected task is marked with `>`; up/down moves that focus for edit.
	 */
	private renderDetail(width: number): string[] {
		const plan = this.plan!;
		const lines: string[] = [];
		const push = (...newLines: string[]): void => {
			lines.push(...newLines);
		};

		const version = plan.revisions.length > 0 ? plan.revisions[plan.revisions.length - 1]!.version : 1;
		const diff = this.error ? `  error: ${this.error}` : "";
		push(...wrap(`# Plan ${plan.id}  [${plan.status}] (v${version})${diff}`, width));
		push(...wrap(`Requirement: ${plan.goal.summary}`, width));
		push(
			...wrap(
				`Gate: ${plan.policy.requireApproval ? "approval required" : "auto-approved"}  ·  Metrics: ${planMetrics(
					plan,
				)}`,
				width,
			),
		);
		push("");

		push("## Strategy");
		push(
			...wrap(
				`kind=${plan.policy.taskKind}  ·  depth=${plan.policy.planningDepth}  ·  verification=${plan.policy.verificationLevel}  ·  max ${plan.policy.maxTasks} tasks`,
				width,
			),
		);
		const strategyFlags = [
			plan.policy.parallelExecution ? "parallel execution" : "sequential",
			plan.policy.specialistAgents ? "specialist agents" : "generalist",
			plan.policy.hierarchicalRefinement ? "hierarchical refinement" : "",
			plan.policy.preferResearch ? "prefer research" : "",
			plan.policy.dualPlanner ? "dual planner" : "",
		].filter((flag) => flag.length > 0);
		if (strategyFlags.length > 0) {
			push(...wrap(strategyFlags.join("  ·  "), width));
		}
		push("");

		if (plan.goal.successCriteria.length > 0 || plan.goal.unknowns.length > 0) {
			push("## Goal");
			if (plan.goal.successCriteria.length > 0) {
				push("Success criteria:");
				for (const criterion of plan.goal.successCriteria) {
					push(...wrapBlock("  - ", criterion, width));
				}
			}
			if (plan.goal.unknowns.length > 0) {
				push("Unknowns:");
				for (const unknown of plan.goal.unknowns) {
					push(...wrapBlock("  - ", unknown, width));
				}
			}
			push("");
		}

		push("## Constraints");
		if (plan.constraints.length === 0) {
			push("- none");
		} else {
			for (const constraint of plan.constraints) {
				push(...wrapBlock(`- [${constraint.kind}] `, constraint.description, width));
			}
		}
		push("");

		push("## Assumptions");
		if (plan.assumptions.length === 0) {
			push("- none");
		} else {
			for (const assumption of plan.assumptions) {
				push(
					...wrapBlock(
						"- ",
						`${assumption.statement} (confidence ${assumption.confidence}, ${assumption.source})`,
						width,
					),
				);
			}
		}
		push("");

		push(`## Tasks (${plan.tasks.length})`);
		if (plan.tasks.length === 0) {
			push("- (no tasks)");
		} else {
			for (let i = 0; i < plan.tasks.length; i++) {
				const task = plan.tasks[i]!;
				const marker = i === this.selectedTaskIndex ? ">" : " ";
				const title = wrap(`${marker} ${task.id}  ${task.title}`, width);
				push(...title.map((line, index) => (index === 0 ? line : `  ${line}`)));
				for (const detail of renderTaskDetail(task)) {
					push(...wrapBlock("    ", detail, width));
				}
				push("");
			}
		}

		push("## DAG");
		if (plan.tasks.length === 0) {
			push("- none");
		} else {
			for (const line of renderPlanDag(plan).split("\n")) {
				push(...wrap(line, width));
			}
		}
		push("");

		push("## Revisions");
		if (plan.revisions.length === 0) {
			push("- none");
		} else {
			for (const line of renderRevisionHistory(plan).split("\n")) {
				push(...wrap(line, width));
			}
		}
		push("");

		const hints =
			plan.status === "needs_review"
				? "[up/down task · a approve · e edit · escape back · r refresh]"
				: "[up/down task · e edit · escape back · r refresh]";
		push(hints);
		push("(scroll the terminal to read the whole plan)");
		return lines;
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

/** A short human-readable metrics summary, or "not scored" when absent. */
function planMetrics(plan: Plan): string {
	if (!plan.metrics) {
		return "not scored";
	}
	const m = plan.metrics;
	return `completeness ${m.completeness} · confidence ${m.confidence} · parallelism ${m.parallelism} · risk ${m.risk} · unknowns ${m.unknownCount}`;
}

/**
 * Wrap `text` at word boundaries so every returned line is at most `width`
 * columns. Long unbroken tokens are hard-sliced; runs of whitespace collapse to
 * a single space. Returns a (possibly empty) array of lines.
 */
function wrap(text: string, width: number): string[] {
	const words = text.split(/\s+/).filter((word) => word.length > 0);
	if (words.length === 0) {
		return [];
	}
	const effective = Math.max(1, width);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (word.length >= effective) {
			if (current.length > 0) {
				lines.push(current);
				current = "";
			}
			for (let i = 0; i < word.length; i += effective) {
				lines.push(word.slice(i, i + effective));
			}
			continue;
		}
		const candidate = current.length === 0 ? word : `${current} ${word}`;
		if (candidate.length > effective) {
			lines.push(current);
			current = word;
		} else {
			current = candidate;
		}
	}
	if (current.length > 0) {
		lines.push(current);
	}
	return lines;
}

/** Wrap `text` to fit `width` and prefix each returned line with `prefix`. */
function wrapBlock(prefix: string, text: string, width: number): string[] {
	const bodyWidth = Math.max(1, width - prefix.length);
	return wrap(text, bodyWidth).map((line) => `${prefix}${line}`);
}

function truncate(text: string, width: number): string {
	return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
