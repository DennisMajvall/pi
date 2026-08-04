/**
 * Deterministic plan view (§6.3.10, Step 2.11).
 *
 * Renders a plan as a reviewable text document — the shared source of truth
 * the TUI plan view displays and any external editor can save. It is pure
 * (never mutates) and deterministic (a plan renders identically every time),
 * so the review gate, the TUI, and on-disk diffing all see one view. Includes
 * the DAG as an indented outline using the 2.10 `analyzeDag` diagnostics.
 */

import type { Plan, RevisionReason } from "../plan/index.ts";
import { analyzeDag } from "./metrics.ts";

/** Render the reviewable head: id, status, version, metrics, gate. */
export function renderPlanHead(plan: Plan): string {
	const version = plan.revisions.length > 0 ? plan.revisions[plan.revisions.length - 1]!.version : 1;
	const metrics = plan.metrics
		? [
				`completeness ${plan.metrics.completeness}`,
				`confidence ${plan.metrics.confidence}`,
				`parallelism ${plan.metrics.parallelism}`,
				`risk ${plan.metrics.risk}`,
				`unknowns ${plan.metrics.unknownCount}`,
			].join("  ")
		: "not scored";
	return [
		`# Plan ${plan.id}  [${plan.status}] (v${version})`,
		`Requirement: ${plan.goal.summary}`,
		`Gate: ${plan.policy.requireApproval ? "approval required" : "auto-approved"}  |  Metrics: ${metrics}`,
	].join("\n");
}

/** Render the plain task list, one line per task with its deps. */
export function renderTaskList(plan: Plan): string {
	if (plan.tasks.length === 0) {
		return "No tasks yet.";
	}
	return plan.tasks
		.map((t) => {
			const deps = t.dependsOn.length > 0 ? `  (after ${t.dependsOn.join(", ")})` : "";
			return `${t.id}  ${t.title}${deps}\n     ${t.purpose}`;
		})
		.join("\n");
}

/**
 * Render the DAG as an indented outline from each root task (a task with no
 * inbound edge). A task may appear under multiple parents in a DAG; each
 * subtree is rendered independently with a per-path visited guard so shared
 * descendants are not duplicated infinitely.
 */
export function renderPlanDag(plan: Plan): string {
	if (plan.tasks.length === 0) {
		return "No tasks yet.";
	}
	const analysis = analyzeDag(plan.tasks);
	const dependsOnById = new Map<string, string[]>();
	for (const task of plan.tasks) {
		dependsOnById.set(
			String(task.id),
			task.dependsOn.map((d) => String(d)),
		);
	}
	const hasInbound = new Set<string>();
	for (const task of plan.tasks) {
		for (const dep of task.dependsOn) {
			hasInbound.add(String(dep));
		}
	}
	const roots = plan.tasks.filter((t) => !hasInbound.has(String(t.id)));

	const lines: string[] = [
		`DAG: ${analysis.taskCount} tasks, ${analysis.edgeCount} edges, critical path ${analysis.maxRank}`,
	];
	const render = (taskId: string, depth: number, path: Set<string>): boolean => {
		if (path.has(taskId)) {
			lines.push(`${"  ".repeat(depth)}${taskId}  (cycle guard)`);
			return false;
		}
		const task = plan.tasks.find((t) => String(t.id) === taskId);
		lines.push(`${"  ".repeat(depth)}${taskId}  ${task?.title ?? "(missing)"}`);
		const nextPath = new Set(path);
		nextPath.add(taskId);
		for (const dep of dependsOnById.get(taskId) ?? []) {
			render(dep, depth + 1, nextPath);
		}
		return true;
	};
	for (const root of roots) {
		render(String(root.id), 0, new Set());
	}
	return lines.join("\n");
}

/** One line per revision in `rev1 (reason) [+n tasks]` form. */
export function renderRevisionHistory(plan: Plan): string {
	if (plan.revisions.length === 0) {
		return "No revisions.";
	}
	const label: Record<RevisionReason, string> = {
		approval: "approved",
		user_edit: "user edit",
		critic: "critic",
		optimizer: "optimizer",
		replan: "replan",
	};
	return plan.revisions
		.map(
			(r) =>
				`v${r.version}  ${label[r.reason]}  ${r.changedTaskIds.length > 0 ? `(+${r.changedTaskIds.join(", ")})` : ""}`,
		)
		.join("\n");
}

/** Render the full reviewable plan view (head, tasks, DAG, revisions). */
export function renderPlanView(plan: Plan): string {
	const sections = [
		renderPlanHead(plan),
		"",
		"## Constraints",
		plan.constraints.length > 0 ? plan.constraints.map((c) => `- [${c.kind}] ${c.description}`).join("\n") : "- none",
		"",
		"## Assumptions",
		plan.assumptions.length > 0
			? plan.assumptions.map((a) => `- ${a.statement} (confidence ${a.confidence}, ${a.source})`).join("\n")
			: "- none",
		"",
		"## Tasks",
		renderTaskList(plan),
		"",
		"## DAG",
		renderPlanDag(plan),
		"",
		"## Revisions",
		renderRevisionHistory(plan),
	];
	return sections.join("\n");
}
