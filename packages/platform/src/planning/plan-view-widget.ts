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
 * Color is injected via `PlanViewStyle`, a bundle of text stylers applied after
 * word-wrapping (so ANSI never affects width measurement); the default identity
 * style keeps the output plain. This keeps the module terminal/model-free: it
 * implements `render(width): string[]` + semantic `handle(action)` and is driven
 * by a thin key/component adapter (the live TUI adapter is 2.13.3) or directly
 * by tests.
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
	| { type: "execute" }
	| { type: "char"; char: string }
	| { type: "backspace" }
	| { type: "refresh" };

/** Which screen the widget is showing. */
export type PlanViewMode = "list" | "detail" | "editing";

/**
 * Text stylers used to colorize plan view output. Each maps a plain string to
 * an ANSI-colored one. The default implementation is the identity function, so
 * the widget renders plain text unless a caller supplies themed stylers.
 */
export interface PlanViewStyle {
	/** The main `# Plan …` / `# Plans …` header line. */
	title(text: string): string;
	/** A `## Section` heading. */
	heading(text: string): string;
	/** A field label such as `Purpose:`, `Requirement:`, `Depends on:`. */
	label(text: string): string;
	/** Plan / task identifiers. */
	id(text: string): string;
	/** A plan-status tag such as `[approved]`. */
	status(text: string): string;
	/** List bullets (`-`, `>`) and selection markers. */
	bullet(text: string): string;
	/** The highlighted selected-task marker. */
	selected(text: string): string;
	/** Muted helper text (footers, hints, "none"). */
	dim(text: string): string;
}

const identity = (text: string): string => text;

const identityStyle: PlanViewStyle = {
	title: identity,
	heading: identity,
	label: identity,
	id: identity,
	status: identity,
	bullet: identity,
	selected: identity,
	dim: identity,
};

/** Spinner frames shown while an edit directive is being applied. */
const EDIT_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Options for constructing the widget. */
export interface PlanViewWidgetOptions {
	runner: PlanCapabilityRunner;
	/** Called when the user backs out of the top-level plan list (returns to chat). */
	onClose?: () => void;
	/** Called with the selected plan when the user requests to execute it. */
	onExecute?: (plan: Plan) => void;
	/** Optional text stylers to colorize output. Defaults to plain text. */
	style?: PlanViewStyle;
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
	private readonly onExecute?: (plan: Plan) => void;
	private readonly style: PlanViewStyle;

	private entries: PlanListEntry[] = [];
	private selectedIndex = 0;
	private mode: PlanViewMode = "list";
	private plan: Plan | undefined;
	private selectedTaskIndex = 0;
	private editBuffer = "";
	private error: string | undefined;
	private editPending = false;
	private editSpinner = 0;

	constructor(options: PlanViewWidgetOptions) {
		this.runner = options.runner;
		this.onClose = options.onClose;
		this.onExecute = options.onExecute;
		this.style = options.style ?? identityStyle;
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

	/** True while an edit directive is being applied (model round-trip in progress). */
	isEditPending(): boolean {
		return this.editPending;
	}

	/** Advance the loading spinner frame; a no-op when no edit is pending. */
	advanceEditSpinner(): void {
		if (this.editPending) {
			this.editSpinner = (this.editSpinner + 1) % EDIT_SPINNER_FRAMES.length;
		}
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
			case "execute":
				await this.execute();
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

	/**
	 * Hand the currently selected (list) / open (detail) plan to `onExecute`.
	 * The host decides how to run it (typically by closing the view and
	 * dispatching an execution prompt to the agent).
	 */
	private async execute(): Promise<void> {
		let plan: Plan | undefined;
		if (this.mode === "detail" && this.plan) {
			plan = this.plan;
		} else if (this.mode === "list") {
			const id = this.selectedPlanId();
			if (id === undefined) {
				return;
			}
			try {
				plan = await this.runner.load(id);
			} catch (error) {
				this.error = toErrorMessage(error);
				return;
			}
		}
		if (plan) {
			this.onExecute?.(plan);
		}
	}

	private async submitEdit(): Promise<void> {
		const directive = this.editBuffer.trim();
		this.mode = "detail";
		this.editBuffer = "";
		if (directive.length === 0 || !this.plan) {
			return;
		}
		this.editPending = true;
		this.editSpinner = 0;
		try {
			this.plan = await this.runner.edit(String(this.plan.id), directive);
			this.error = undefined;
		} catch (error) {
			this.error = toErrorMessage(error);
		} finally {
			this.editPending = false;
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

	/** Render the current screen as plain lines (each ≤ `width` visible cols). */
	render(width: number): string[] {
		let lines: string[];
		if (this.mode === "detail" && this.plan) {
			lines = this.renderDetail(width);
		} else if (this.mode === "editing" && this.plan) {
			lines = this.renderEditing(width);
		} else {
			lines = this.renderList(width);
		}
		if (this.editPending) {
			lines.unshift(this.editStatusLine());
		}
		return lines;
	}

	/** A single animated status line shown while an edit is being applied. */
	private editStatusLine(): string {
		const frame = EDIT_SPINNER_FRAMES[this.editSpinner]!;
		return this.style.dim(`${frame} Applying edit…`);
	}

	private renderList(width: number): string[] {
		const st = this.style;
		const lines: string[] = [st.title(`# Plans (${this.entries.length})`), ""];
		if (this.entries.length === 0) {
			lines.push(st.dim("No plans yet. Create one with /plan <request>."));
		} else {
			for (let i = 0; i < this.entries.length; i++) {
				const entry = this.entries[i]!;
				const marker = i === this.selectedIndex ? "> " : "  ";
				const metrics = entry.metrics ? `  ${entry.metrics}` : "";
				let line = truncate(
					`${marker}${entry.id}  ${entry.title}  [${entry.status}] (v${entry.version})  ${entry.taskCount} tasks${metrics}`,
					width,
				);
				line = tint(line, marker, i === this.selectedIndex ? st.selected : identity);
				line = tint(line, String(entry.id), st.id);
				line = tint(line, `[${entry.status}]`, st.status);
				lines.push(line);
			}
		}
		if (this.error) {
			lines.push("", st.dim(`error: ${this.error}`));
		}
		lines.push(
			"",
			st.dim(
				this.entries.length > 0
					? "[up/down navigate · enter open · g run · escape quit · r refresh]"
					: "[escape quit · r refresh]",
			),
		);
		return lines;
	}

	/**
	 * Detail view: the whole plan as one word-wrapped document spanning the full
	 * terminal width. Every section is printed in full (goal, strategy,
	 * constraints, assumptions, tasks, DAG, revisions) so the terminal's
	 * scrollback can be used to read it rather than truncating long prose. Each
	 * section heading is followed by a blank line, and the selected task is
	 * marked with `>`; up/down moves that focus for edit.
	 */
	private renderDetail(width: number): string[] {
		const plan = this.plan!;
		const st = this.style;
		const lines: string[] = [];
		const push = (...newLines: string[]): void => {
			lines.push(...newLines);
		};

		const version = plan.revisions.length > 0 ? plan.revisions[plan.revisions.length - 1]!.version : 1;
		const diff = this.error ? `  error: ${this.error}` : "";

		let header = wrap(`# Plan ${plan.id}  [${plan.status}] (v${version})${diff}`, width);
		header = tintLine(header, "# Plan", st.title);
		header = tintLine(header, String(plan.id), st.id);
		header = tintLine(header, `[${plan.status}]`, st.status);
		push(...header);

		let requirement = wrap(`Requirement: ${plan.goal.summary}`, width);
		requirement = tintLine(requirement, "Requirement:", st.label);
		push(...requirement);

		let gate = wrap(
			`Gate: ${plan.policy.requireApproval ? "approval required" : "auto-approved"}  ·  Metrics: ${planMetrics(
				plan,
			)}`,
			width,
		);
		gate = tintLine(gate, "Gate:", st.label);
		gate = tintLine(gate, "Metrics:", st.label);
		push(...gate);
		push("");

		push(st.heading("## Strategy"));
		push("");
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
			push(st.heading("## Goal"));
			push("");
			if (plan.goal.successCriteria.length > 0) {
				push(st.label("Success criteria:"));
				for (const criterion of plan.goal.successCriteria) {
					push(...tintLine(wrapBlock("  - ", criterion, width), "-", st.bullet));
				}
			}
			if (plan.goal.unknowns.length > 0) {
				push(st.label("Unknowns:"));
				for (const unknown of plan.goal.unknowns) {
					push(...tintLine(wrapBlock("  - ", unknown, width), "-", st.bullet));
				}
			}
			push("");
		}

		push(st.heading("## Constraints"));
		push("");
		if (plan.constraints.length === 0) {
			push(st.dim("- none"));
		} else {
			for (const constraint of plan.constraints) {
				let constraintLines = wrapBlock(`- [${constraint.kind}] `, constraint.description, width);
				constraintLines = tintLine(constraintLines, "-", st.bullet);
				constraintLines = tintLine(constraintLines, `[${constraint.kind}]`, st.id);
				push(...constraintLines);
			}
		}
		push("");

		push(st.heading("## Assumptions"));
		push("");
		if (plan.assumptions.length === 0) {
			push(st.dim("- none"));
		} else {
			for (const assumption of plan.assumptions) {
				push(
					...tintLine(
						wrapBlock(
							"- ",
							`${assumption.statement} (confidence ${assumption.confidence}, ${assumption.source})`,
							width,
						),
						"-",
						st.bullet,
					),
				);
			}
		}
		push("");

		push(st.heading(`## Tasks (${plan.tasks.length})`));
		push("");
		if (plan.tasks.length === 0) {
			push(st.dim("- (no tasks)"));
		} else {
			for (let i = 0; i < plan.tasks.length; i++) {
				const task = plan.tasks[i]!;
				const isSelected = i === this.selectedTaskIndex;
				const marker = isSelected ? "> " : "  ";
				let titleLines = wrap(`${marker}${task.id}  ${task.title}`, width);
				titleLines = titleLines.map((line, index) => (index === 0 ? line : `  ${line}`));
				titleLines = tintLine(titleLines, marker, isSelected ? st.selected : identity);
				titleLines = tintLine(titleLines, String(task.id), st.id);
				push(...titleLines);
				for (const detail of renderTaskDetail(task)) {
					const { label, body } = splitLabel(detail);
					push(
						...tintLine(wrapBlock("    ", body.length > 0 ? `${label} ${body}` : label, width), label, st.label),
					);
				}
				push("");
			}
		}

		push(st.heading("## DAG"));
		push("");
		if (plan.tasks.length === 0) {
			push(st.dim("- none"));
		} else {
			const dagLines = renderPlanDag(plan).split("\n");
			for (let i = 0; i < dagLines.length; i++) {
				let dagLine = wrap(dagLines[i]!, width);
				if (i === 0) {
					dagLine = tintLine(dagLine, "DAG:", st.label);
				}
				push(...dagLine);
			}
		}
		push("");

		push(st.heading("## Revisions"));
		push("");
		if (plan.revisions.length === 0) {
			push(st.dim("- none"));
		} else {
			for (const revision of renderRevisionHistory(plan).split("\n")) {
				push(...wrap(revision, width));
			}
		}
		push("");

		const hints =
			plan.status === "needs_review"
				? "[up/down task · a approve · e edit · g run · escape back · r refresh]"
				: "[up/down task · e edit · g run · escape back · r refresh]";
		push(st.dim(hints));
		push(st.dim("(scroll the terminal to read the whole plan)"));
		return lines;
	}

	private renderEditing(width: number): string[] {
		const plan = this.plan!;
		const st = this.style;
		const version = plan.revisions.length > 0 ? plan.revisions[plan.revisions.length - 1]!.version : 1;
		const head = st.title(truncate(`# Plan ${plan.id}  [${plan.status}] (v${version})`, width));
		const promptSource = `edit > ${this.editBuffer}${this.editBuffer.length > 0 ? "" : " "}`;
		const prompt = tint(truncate(promptSource, width), "edit >", st.label);
		const hint = st.dim("[type a directive like 'merge t2 and t3' · enter apply · escape cancel]");
		return [
			head,
			...wrap(plan.goal.summary, width),
			"",
			prompt,
			"",
			this.error ? st.dim(`error: ${this.error}`) : hint,
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

/** Split a `Label: body` line into its label (including trailing colon) and body. */
function splitLabel(line: string): { label: string; body: string } {
	const index = line.indexOf(": ");
	if (index === -1) {
		return { label: line, body: "" };
	}
	return { label: line.slice(0, index + 1), body: line.slice(index + 2) };
}

/**
 * Wrap `text` at word boundaries so every returned line is at most `width`
 * visible columns. Long unbroken tokens are hard-sliced; runs of whitespace
 * collapse to a single space. Input must be free of ANSI escape sequences.
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

/**
 * Wrap `text` to fit `width` and prefix the first line with `prefix`. Wrapped
 * continuation lines are indented to the same column as the first line (spaced
 * out to `prefix` width) instead of repeating the prefix, so a bulleted list or
 * labelled field never re-emits its bullet/label on every wrapped line.
 */
function wrapBlock(prefix: string, text: string, width: number): string[] {
	const bodyWidth = Math.max(1, width - prefix.length);
	const wrapped = wrap(text, bodyWidth);
	if (wrapped.length === 0) {
		return [];
	}
	const continuation = " ".repeat(prefix.length);
	return wrapped.map((line, index) => (index === 0 ? `${prefix}${line}` : `${continuation}${line}`));
}

/**
 * Replace the first occurrence of `token` in a single string with its styled
 * form, leaving the rest unchanged. No-op if the token is absent.
 */
function tint(text: string, token: string, colour: (text: string) => string): string {
	const index = text.indexOf(token);
	if (index === -1) {
		return text;
	}
	return `${text.slice(0, index)}${colour(token)}${text.slice(index + token.length)}`;
}

/** Apply `tint` to the first line of `lines`. */
function tintLine(lines: string[], token: string, colour: (text: string) => string): string[] {
	if (lines.length === 0) {
		return lines;
	}
	lines[0] = tint(lines[0]!, token, colour);
	return lines;
}

function truncate(text: string, width: number): string {
	return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
