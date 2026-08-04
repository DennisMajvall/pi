/**
 * Deterministic Plan Validation (Architecture §6.3.8) — Step 2.10.
 *
 * Validates a finished plan before review/execution: schema-validates the full
 * plan, re-runs the acyclicity check on the persisted DAG (edges derived from
 * `dependsOn`), and runs the coverage check (every success criterion reachable
 * from some task output, every task has a purpose, no duplicate deliverables).
 *
 * A validation failure here is a pipeline bug — a stage output violated its
 * contract — not a user error. It is the signal the producing stage's
 * retry/degrade path handles (Scheduler/2.12); this module only reports issues,
 * it never mutates the plan.
 */

import { Value } from "typebox/value";
import type { Plan, Task } from "../plan/index.ts";
import { PlanSchema } from "../schema/plan.ts";
import { type DependencyEdge, findCircularDependencies } from "./dependency-builder.ts";

/** The class of a validation issue found. */
export const ValidationIssueCode = {
	Schema: "schema",
	Cycle: "cycle",
	UnreachableCriterion: "unreachable_criterion",
	TaskPurpose: "task_purpose",
	DuplicateDeliverable: "duplicate_deliverable",
} as const;
export type ValidationIssueCode = (typeof ValidationIssueCode)[keyof typeof ValidationIssueCode];

/** One validation issue: a code, a human message, and an optional JSON path. */
export interface ValidationIssue {
	code: ValidationIssueCode;
	message: string;
	path?: string;
}

/** The outcome of `validatePlan`. `valid` is true iff there are no issues. */
export interface PlanValidationResult {
	valid: boolean;
	issues: ValidationIssue[];
}

/**
 * Validates the full plan deterministically. Returns issues (never throws); a
 * non-empty issue list means the plan failed validation and is a pipeline bug
 * reported to the producing stage's retry/degrade path.
 */
export function validatePlan(plan: Plan): PlanValidationResult {
	const issues: ValidationIssue[] = [];
	schemaIssues(plan, issues);
	acyclicityIssues(plan.tasks, issues);
	coverageIssues(plan, issues);
	return { valid: issues.length === 0, issues };
}

/** Schema-validate the full plan against `PlanSchema` (a stored plan must pass). */
function schemaIssues(plan: Plan, issues: ValidationIssue[]): void {
	if (Value.Check(PlanSchema, plan)) {
		return;
	}
	for (const error of Value.Errors(PlanSchema, plan)) {
		const path = error instanceof Error && "instancePath" in error ? error.instancePath : "/";
		issues.push({ code: ValidationIssueCode.Schema, message: error.message, path });
	}
	if (issues.every((i) => i.code !== ValidationIssueCode.Schema)) {
		issues.push({ code: ValidationIssueCode.Schema, message: "plan does not match the Plan schema" });
	}
}

/** Re-run acyclicity on the persisted DAG (edges derived from `dependsOn`). */
function acyclicityIssues(tasks: Task[], issues: ValidationIssue[]): void {
	const edges: DependencyEdge[] = [];
	for (const task of tasks) {
		for (const dep of task.dependsOn) {
			edges.push({ from: String(dep), to: String(task.id) });
		}
	}
	for (const cycle of findCircularDependencies(tasks, edges)) {
		issues.push({ code: ValidationIssueCode.Cycle, message: `circular dependency: ${cycle.join(" -> ")}` });
	}
}

/** Coverage check (§6.3.8): reachable criteria, purposeful tasks, unique deliverables. */
function coverageIssues(plan: Plan, issues: ValidationIssue[]): void {
	// Every success criterion must be reachable from some task's produced artifact.
	const produced = new Set<string>();
	for (const task of plan.tasks) {
		produced.add(task.deliverable);
		for (const output of task.outputs) {
			produced.add(output);
		}
	}
	for (const criterion of plan.goal.successCriteria) {
		if (!produced.has(criterion)) {
			issues.push({
				code: ValidationIssueCode.UnreachableCriterion,
				message: `success criterion not produced by any task: "${criterion}"`,
			});
		}
	}

	// Every task must have a purpose (why it exists), never an empty one.
	for (const task of plan.tasks) {
		if (task.purpose.trim().length === 0) {
			issues.push({
				code: ValidationIssueCode.TaskPurpose,
				message: `task ${task.id} ("${task.title}") has no purpose`,
				path: `/tasks/${task.id}`,
			});
		}
	}

	// No two tasks may share a deliverable (that is a hidden duplicate).
	const byDeliverable = new Map<string, string[]>();
	for (const task of plan.tasks) {
		const list = byDeliverable.get(task.deliverable) ?? [];
		list.push(String(task.id));
		byDeliverable.set(task.deliverable, list);
	}
	for (const [deliverable, ids] of byDeliverable) {
		if (ids.length > 1) {
			issues.push({
				code: ValidationIssueCode.DuplicateDeliverable,
				message: `duplicate deliverable "${deliverable}" produced by tasks: ${ids.join(", ")}`,
			});
		}
	}
}
