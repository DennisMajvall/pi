/**
 * Schema-preserving `user_edit` capability (§6.3.10, Step 2.11).
 *
 * The User Review gate is conversational: the user edits a plan with prompts
 * ("merge tasks 3 and 4", "move deployment after testing", "run frontend and
 * backend in parallel", "split auth"). A small deterministic engine applies
 * those edits **schema-preserving** — the result always validates against
 * `PlanSchema` and stays a DAG (an edit that would introduce a cycle is
 * rejected) — and records a `user_edit` revision (§8) with the changed task
 * ids, refreshing `updatedAt`.
 *
 * The primary API is the typed `PlanEdit` union (what the TUI/agent sends).
 * `parsePlanEdit` additionally translates the common conversational one-liners
 * into `PlanEdit` operations, resolving task references by id, title, or the
 * `t<N>` id form. `userEditStage` wraps the flow as an `orchestration`
 * capability (load → apply → save).
 */

import { Value } from "typebox/value";
import type { CapabilityId } from "../identifier/index.ts";
import { taskId } from "../identifier/index.ts";
import type { Constraint, ConstraintKind, Plan, PlanningPolicy, Task } from "../plan/index.ts";
import { PlanningPolicySchema, PlanSchema } from "../schema/plan.ts";
import { findCircularDependencies } from "./dependency-builder.ts";
import type { PlanningStage } from "./stage.ts";
import { appendPlanRevision } from "./user-review.ts";

/** A task reference inside an edit: an id, a `t<N>` id, or a title. */
export type TaskRef = string;

/**
 * A canonical, schema-preserving plan edit. Each op is applied deterministically
 * and bumps the plan's `user_edit` revision.
 */
export type PlanEdit =
	| { op: "rename"; task: TaskRef; title: string }
	| {
			op: "repurpose";
			task: TaskRef;
			purpose?: string;
			deliverable?: string;
	  } /** "move X after Y": add `dependsOn` edges (rejected if it would cycle). */
	| {
			op: "add_dependency";
			task: TaskRef;
			dependsOn: TaskRef[];
	  } /** "run X in parallel with Y": drop dependency edges (always acyclic). */
	| { op: "remove_dependency"; task: TaskRef; dependsOn: TaskRef[] }
	| { op: "merge"; tasks: TaskRef[]; into: { title?: string; purpose?: string; deliverable?: string } }
	| { op: "split"; task: TaskRef; parts: { title: string; purpose?: string; deliverable?: string }[] }
	| { op: "add_constraint"; kind: ConstraintKind; description: string }
	| { op: "set_policy"; field: string; value: unknown };

function resolveTask(plan: Plan, ref: TaskRef): Task {
	const s = String(ref)
		.trim()
		.replace(/^tasks?\s+/i, "");
	const byId = plan.tasks.find((t) => t.id === s);
	if (byId) {
		return byId;
	}
	const prefixed = /^\d+$/.test(s) ? `t${s}` : null;
	if (prefixed) {
		const byPrefix = plan.tasks.find((t) => t.id === prefixed);
		if (byPrefix) {
			return byPrefix;
		}
	}
	const byTitle = plan.tasks.find((t) => t.title.toLowerCase() === s.toLowerCase());
	if (byTitle) {
		return byTitle;
	}
	const bySubstr = plan.tasks.find((t) => t.title.toLowerCase().includes(s.toLowerCase()));
	if (bySubstr) {
		return bySubstr;
	}
	throw new Error(`plan edit: no task matches "${s}"`);
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function unionIds(tasks: Task[]): string[] {
	return unique(tasks.flatMap((t) => [...t.dependsOn.map((d) => String(d))]));
}

/** Validate that the given `dependsOn` graph is acyclic; throw otherwise. */
function assertAcyclic(tasks: Task[]): void {
	const edges = tasks.flatMap((t) => t.dependsOn.map((dep) => ({ from: String(dep), to: String(t.id) })));
	const cycles = findCircularDependencies(tasks, edges);
	if (cycles.length > 0) {
		throw new Error(`plan edit rejected: would introduce a dependency cycle (${cycles[0]!.join(" → ")})`);
	}
}

/** Build the canonical `requiresAcyclic` post-edit plan and validate it. */
function finalize(
	plan: Plan,
	tasks: Task[],
	constraints: Constraint[],
	policy: PlanningPolicy,
	changedIds: string[],
): Plan {
	assertAcyclic(tasks);
	assertAcyclicTasksSchema(tasks);
	const next: Plan = {
		...plan,
		tasks,
		constraints,
		policy,
		updatedAt: Date.now(),
	};
	if (!Value.Check(PlanSchema, next)) {
		const errors = Value.Errors(PlanSchema, next)
			.map((e) => `${"instancePath" in e ? e.instancePath : "/"} ${e.message}`.trim())
			.join("; ");
		throw new Error(`plan edit produced an invalid plan: ${errors}`);
	}
	return appendPlanRevision(
		next,
		"user_edit",
		changedIds.map((id) => taskId(id)),
	);
}

function assertAcyclicTasksSchema(tasks: Task[]): void {
	// dependsOn must reference existing task ids (schema-preserving).
	const ids = new Set(tasks.map((t) => String(t.id)));
	for (const t of tasks) {
		for (const dep of t.dependsOn) {
			if (!ids.has(String(dep))) {
				throw new Error(`plan edit rejected: task "${t.id}" depends on missing task "${dep}"`);
			}
		}
	}
}

/** Apply a single `PlanEdit` to a plan, returning a schema-preserving new plan. */
export function applyPlanEdit(plan: Plan, edit: PlanEdit): Plan {
	switch (edit.op) {
		case "rename":
			return rename(plan, edit);
		case "repurpose":
			return repurpose(plan, edit);
		case "add_dependency":
			return addDependency(plan, edit);
		case "remove_dependency":
			return removeDependency(plan, edit);
		case "merge":
			return mergeTasks(plan, edit);
		case "split":
			return splitTask(plan, edit);
		case "add_constraint":
			return addConstraint(plan, edit);
		case "set_policy":
			return setPolicy(plan, edit);
	}
}

function rename(plan: Plan, edit: Extract<PlanEdit, { op: "rename" }>): Plan {
	const task = resolveTask(plan, edit.task);
	const title = edit.title.trim();
	if (!title) {
		throw new Error("plan edit: rename requires a non-empty title");
	}
	const tasks = plan.tasks.map((t) => (t.id === task.id ? { ...t, title } : t));
	return finalize(plan, tasks, plan.constraints, plan.policy, [String(task.id)]);
}

function repurpose(plan: Plan, edit: Extract<PlanEdit, { op: "repurpose" }>): Plan {
	const task = resolveTask(plan, edit.task);
	const purpose = edit.purpose !== undefined ? edit.purpose.trim() : task.purpose;
	const deliverable = edit.deliverable !== undefined ? edit.deliverable.trim() : task.deliverable;
	const oldDeliverable = task.deliverable;
	const changed = new Set<string>([String(task.id)]);
	const tasks = plan.tasks.map((t) => {
		if (t.id === task.id) {
			return { ...t, purpose, deliverable };
		}
		if (edit.deliverable !== undefined && t.inputs.includes(oldDeliverable)) {
			changed.add(String(t.id));
			return { ...t, inputs: t.inputs.map((i) => (i === oldDeliverable ? deliverable : i)) };
		}
		return t;
	});
	return finalize(plan, tasks, plan.constraints, plan.policy, [...changed]);
}

function addDependency(plan: Plan, edit: Extract<PlanEdit, { op: "add_dependency" }>): Plan {
	const task = resolveTask(plan, edit.task);
	const deps = edit.dependsOn.map((ref) => String(resolveTask(plan, ref).id));
	const newDeps = unique([...task.dependsOn.map((d) => String(d)), ...deps]).filter((d) => d !== String(task.id));
	const tasks = plan.tasks.map((t) => (t.id === task.id ? { ...t, dependsOn: newDeps.map((id) => taskId(id)) } : t));
	return finalize(plan, tasks, plan.constraints, plan.policy, [String(task.id)]);
}

function removeDependency(plan: Plan, edit: Extract<PlanEdit, { op: "remove_dependency" }>): Plan {
	const task = resolveTask(plan, edit.task);
	const deps = new Set(edit.dependsOn.map((ref) => String(resolveTask(plan, ref).id)));
	const newDeps = task.dependsOn.filter((d) => !deps.has(String(d)));
	const tasks = plan.tasks.map((t) => (t.id === task.id ? { ...t, dependsOn: newDeps } : t));
	return finalize(plan, tasks, plan.constraints, plan.policy, [String(task.id)]);
}

function mergeTasks(plan: Plan, edit: Extract<PlanEdit, { op: "merge" }>): Plan {
	const targets = edit.tasks.map((ref) => resolveTask(plan, ref));
	if (targets.length < 2) {
		throw new Error("plan edit: merge requires at least two tasks");
	}
	const removed = new Set(targets.map((t) => String(t.id)));
	const mergedId = targets[0]!.id;
	const merged: Task = {
		id: mergedId,
		title: edit.into.title?.trim() || targets[0]!.title,
		purpose: edit.into.purpose?.trim() || targets[0]!.purpose,
		deliverable: edit.into.deliverable?.trim() || targets[0]!.deliverable,
		inputs: unique(targets.flatMap((t) => t.inputs)),
		outputs: unique(targets.flatMap((t) => t.outputs)),
		dependsOn: unionIds(targets)
			.filter((d) => !removed.has(d))
			.map((id) => taskId(id)),
		requiredCapabilities: dedupeCapabilities(targets.flatMap((t) => t.requiredCapabilities)),
		verification: targets.find((t) => t.verification)?.verification ?? "",
	};
	const changed = new Set<string>(targets.map((t) => String(t.id)));
	const rewired = plan.tasks
		.filter((t) => !removed.has(String(t.id)))
		.map((t) => {
			const dependsOn = unique(t.dependsOn.map((d) => (removed.has(String(d)) ? String(mergedId) : String(d)))).map(
				(id) => taskId(id),
			);
			const same =
				dependsOn.length === t.dependsOn.length && dependsOn.every((d, i) => String(d) === String(t.dependsOn[i]));
			if (same) {
				return t;
			}
			changed.add(String(t.id));
			return { ...t, dependsOn };
		});
	return finalize(plan, [merged, ...rewired], plan.constraints, plan.policy, [...changed]);
}

function dedupeCapabilities(caps: CapabilityId[]): CapabilityId[] {
	return [...new Set(caps.map((c) => String(c)))].map((c) => capId(c));
}

function capId(id: string): CapabilityId {
	// Reuse the platform capability-id convention through the Task field type.
	return id as CapabilityId;
}

function splitTask(plan: Plan, edit: Extract<PlanEdit, { op: "split" }>): Plan {
	const task = resolveTask(plan, edit.task);
	if (edit.parts.length < 2) {
		throw new Error("plan edit: split requires at least two parts");
	}
	const newIds = edit.parts.map((_, i) => taskId(`${String(task.id)}-${i + 1}`));
	const newTasks: Task[] = edit.parts.map((part, i) => ({
		id: newIds[i]!,
		title: part.title.trim(),
		purpose: part.purpose?.trim() || task.purpose,
		deliverable: part.deliverable?.trim() || part.title.trim(),
		inputs: [...task.inputs],
		outputs: [...task.outputs],
		dependsOn: [...task.dependsOn].filter((d) => String(d) !== String(task.id)),
		requiredCapabilities: [...task.requiredCapabilities],
		verification: task.verification,
	}));
	const changed = new Set<string>([String(task.id), ...newIds.map((id) => String(id))]);
	const rewired = plan.tasks
		.filter((t) => String(t.id) !== String(task.id))
		.map((t) => {
			if (t.dependsOn.some((d) => String(d) === String(task.id))) {
				changed.add(String(t.id));
				return {
					...t,
					dependsOn: unique([
						...t.dependsOn.filter((d) => String(d) !== String(task.id)).map((d) => String(d)),
						...newIds.map((id) => String(id)),
					]).map((id) => taskId(id)),
				};
			}
			return t;
		});
	return finalize(plan, [...newTasks, ...rewired], plan.constraints, plan.policy, [...changed]);
}

function addConstraint(plan: Plan, edit: Extract<PlanEdit, { op: "add_constraint" }>): Plan {
	const description = edit.description.trim();
	if (!description) {
		throw new Error("plan edit: add_constraint requires a description");
	}
	const constraint: Constraint = { kind: edit.kind, description };
	return finalize(plan, plan.tasks, [...plan.constraints, constraint], plan.policy, []);
}

function setPolicy(plan: Plan, edit: Extract<PlanEdit, { op: "set_policy" }>): Plan {
	// Build via a string-keyed object and rely on the PlanningPolicySchema check;
	// a computed key on the branded type is not assignable, but the schema makes
	// the cast safe.
	const candidate: Record<string, unknown> = { ...plan.policy };
	candidate[edit.field] = edit.value;
	if (!Value.Check(PlanningPolicySchema, candidate)) {
		throw new Error(`plan edit: invalid value for policy field "${edit.field}"`);
	}
	return finalize(plan, plan.tasks, plan.constraints, candidate as PlanningPolicy, []);
}

/**
 * Translate a conversational directive into a `PlanEdit`. Supports the
 * architecture's examples: "merge tasks 3 and 4 into X", "move A after B",
 * "parallel A and B" / "run A in parallel with B", "split A into B, C",
 * "rename A to B", "add constraint <desc>" and "set <field> to <value>".
 * Throws for an unrecognized directive — the typed `PlanEdit` API remains the
 * primary surface.
 */
export function parsePlanEdit(directive: string, plan: Plan): PlanEdit {
	const text = directive.trim();
	const out =
		directiveMatch(text, /^rename\s+(.+?)\s+to\s+(.+)$/i, (m) => ({
			op: "rename",
			task: String(resolveTask(plan, m[1]!).id),
			title: m[2]!,
		})) ??
		directiveMatch(text, /^merge\s+(.+?)\s+and\s+(.+?)\s+into\s+(.+)$/i, (m) =>
			mergeDirective(plan, m[1]!, m[2]!, m[3]!),
		) ??
		directiveMatch(text, /^merge\s+(.+?)\s+and\s+(.+)$/i, (m) => mergeDirective(plan, m[1]!, m[2]!)) ??
		directiveMatch(text, /^move\s+(.+?)\s+after\s+(.+)$/i, (m) => ({
			op: "add_dependency",
			task: String(resolveTask(plan, m[1]!).id),
			dependsOn: [String(resolveTask(plan, m[2]!).id)],
		})) ??
		directiveMatch(text, /^split\s+(.+?)\s+into\s+(.+)$/i, (m) => {
			const parts = m[2]!
				.split(/,|\band\b/i)
				.map((p) => p.trim())
				.filter(Boolean);
			if (parts.length < 2) {
				throw new Error(`plan edit: split requires at least two parts in "${directive}"`);
			}
			return { op: "split", task: String(resolveTask(plan, m[1]!).id), parts: parts.map((title) => ({ title })) };
		}) ??
		directiveMatch(
			text,
			/^add\s+(?:a\s+)?(hard|soft|resource|policy)\s+(?:constraint\s*:\s*|constraint\s+)?(.+)$/i,
			(m) => ({ op: "add_constraint", kind: m[1]!.toLowerCase() as ConstraintKind, description: m[2]! }),
		) ??
		directiveMatch(text, /^(?:run\s+)?(.+?)\s+in\s+parallel\s+with\s+(.+)$/i, (m) =>
			parallelEdits(m[1]!, m[2]!, plan),
		) ??
		directiveMatch(text, /^(.+?)\s+parallel\s+(?:to|with)\s+(.+)$/i, (m) => parallelEdits(m[1]!, m[2]!, plan)) ??
		directiveMatch(text, /^set\s+([\w.]+)\s+to\s+(.+)$/i, (m) => ({
			op: "set_policy",
			field: m[1]!,
			value: coerceDirectiveValue(m[2]!),
		}));
	if (out === undefined) {
		throw new Error(`plan edit: unsupported directive "${directive}"`);
	}
	return out;
}

/** Run `pattern` against `text` and map its match to a edit, or return undefined. */
function directiveMatch(
	text: string,
	pattern: RegExp,
	onMatch: (m: RegExpExecArray) => PlanEdit,
): PlanEdit | undefined {
	const match = pattern.exec(text);
	return match ? onMatch(match) : undefined;
}

/** "A parallel B" drops the dependency edge between A and B in the direction it exists. */
function parallelEdits(a: string, b: string, plan: Plan): PlanEdit {
	const aTask = resolveTask(plan, a);
	const bTask = resolveTask(plan, b);
	const aId = String(aTask.id);
	const bId = String(bTask.id);
	if (aTask.dependsOn.some((d) => String(d) === bId)) {
		return { op: "remove_dependency", task: aId, dependsOn: [bId] };
	}
	if (bTask.dependsOn.some((d) => String(d) === aId)) {
		return { op: "remove_dependency", task: bId, dependsOn: [aId] };
	}
	// No edge between them: keep them parallel (already the case) — no-op edit.
	return { op: "remove_dependency", task: aId, dependsOn: [] };
}

function mergeDirective(plan: Plan, aRaw: string, bRaw: string, intoTitle?: string): PlanEdit {
	const a = resolveTask(plan, aRaw);
	const b = resolveTask(plan, bRaw);
	return {
		op: "merge",
		tasks: [String(a.id), String(b.id)],
		into: intoTitle ? { title: intoTitle } : { title: a.title },
	};
}

function coerceDirectiveValue(raw: string): unknown {
	const lower = raw.toLowerCase();
	if (lower === "true" || lower === "on" || lower === "yes") {
		return true;
	}
	if (lower === "false" || lower === "off" || lower === "no") {
		return false;
	}
	if (/^\d+$/.test(raw)) {
		return Number.parseInt(raw, 10);
	}
	if (["low", "medium", "high"].includes(lower)) {
		return lower;
	}
	if (["none", "basic", "strict"].includes(lower)) {
		return lower;
	}
	if (["research", "implementation", "debugging", "design", "maintenance", "mixed"].includes(lower)) {
		return lower;
	}
	return raw;
}

/** Apply a sequence of edits in order (each bumps a `user_edit` revision). */
export function applyPlanEdits(plan: Plan, edits: PlanEdit[]): Plan {
	return edits.reduce((acc, edit) => applyPlanEdit(acc, edit), plan);
}

/** Input to the `orchestration.plan.edit` capability. */
export interface UserEditInput {
	planId: string;
	/** Either a typed edit or a conversational directive string. */
	edit: PlanEdit | string;
}

function normalizeEditInput(input: unknown): UserEditInput {
	if (typeof input !== "object" || input === null) {
		throw new Error("user edit: input must be { planId, edit }");
	}
	const obj = input as { planId?: unknown; edit?: unknown };
	if (typeof obj.planId !== "string" || obj.planId.length === 0) {
		throw new Error("user edit: input `planId` must be a non-empty string");
	}
	if (obj.edit === undefined) {
		throw new Error("user edit: input `edit` is required");
	}
	return { planId: obj.planId, edit: obj.edit as PlanEdit | string };
}

/**
 * The `user_edit` capability (`orchestration.plan.edit`): loads the plan,
 * applies the edit (parsing a directive string if given), persists, and returns
 * the updated plan. Deterministic and schema-preserving.
 */
export const userEditStage: PlanningStage<typeof PlanSchema> = {
	id: "orchestration.plan.edit",
	category: "orchestration",
	name: "Plan Editor",
	description: "Apply a schema-preserving conversational edit to a plan and record a user_edit revision.",
	inputs: ["plan"],
	outputSchema: PlanSchema,
	mandatory: true,
	run: async (input, ctx) => {
		const { planId, edit } = normalizeEditInput(input);
		const plan = await ctx.store.load(planId);
		const planned: PlanEdit = typeof edit === "string" ? parsePlanEdit(edit, plan) : edit;
		const next = applyPlanEdit(plan, planned);
		await ctx.store.save(next);
		return next;
	},
};
