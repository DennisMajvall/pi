/**
 * PlanStore — the durable, workspace-scoped owner of plan documents (Step 2.2).
 *
 * Scope: project/workspace. Plans live as one JSON file per plan under
 * `<root>/{plansDir}` (default `plans`). On-disk JSON is the source of truth.
 *
 * Read-through, never a cache: every `load`/`list` reads straight from disk, so
 * an external editor edit is picked up at the point of use — there is no
 * in-memory copy that can drift. Each plan file holds the *full* Plan document
 * including its embedded `revisions` history; saving re-stores the whole doc
 * (full-document re-store per revision, Architecture §8). `revise` encodes that
 * rule: load the freshest doc, apply a mutation, append a `revision` entry with
 * an incremented `version` and refreshed `updatedAt`, then re-store.
 *
 * Behaviour:
 * - `save`/`load`/`list`/`exists`/`delete` over the plans directory.
 * - `save` and `load` validate against `PlanSchema`; invalid in-memory input and
 *   invalid on-disk content both fail loudly (`ValidationError`).
 * - `list` returns a `PlanSummary` for each valid plan file (skipping unparseable
 *   or invalid ones — those surface on `load`).
 * - Plan ids are validated against a safe filename pattern (no path traversal).
 */

import {
	access as fsAccess,
	mkdir as fsMkdir,
	readdir as fsReaddir,
	readFile as fsReadFile,
	rename as fsRename,
	rm as fsRm,
	stat as fsStat,
	writeFile as fsWriteFile,
} from "node:fs/promises";
import { join } from "node:path";
import { Value } from "typebox/value";
import { NotFoundError, ValidationError } from "../error/index.ts";
import type { TaskId } from "../identifier/index.ts";
import type { Plan, PlanStatus, RevisionReason } from "../plan/index.ts";
import type { ValidationResult } from "../runtime/index.ts";
import { PlanSchema } from "../schema/plan.ts";

/** Safe plan-id filename pattern: no separators, no leading dots. */
const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Options for constructing a PlanStore. */
export interface PlanStoreOptions {
	/** Project/workspace root under which the plans directory lives. */
	rootDir: string;
	/** Directory name relative to rootDir. Defaults to "plans". */
	plansDirName?: string;
}

/** Lightweight metadata about a persisted plan, without the full document. */
export interface PlanSummary {
	id: string;
	status: PlanStatus;
	/** Latest revision version (1 if the plan has no revisions yet). */
	version: number;
	updatedAt: number;
	/** File mtime (ms) — the external-edit timestamp consumers can stat. */
	modifiedAt: number;
	taskCount: number;
}

function validatePlan(value: unknown): ValidationResult {
	if (Value.Check(PlanSchema, value)) {
		return { valid: true, errors: [], warnings: [] };
	}
	const errors = Value.Errors(PlanSchema, value).map((error) => {
		const path = error instanceof Error && "instancePath" in error ? error.instancePath : "/";
		return `${path} ${error.message}`.trim();
	});
	return { valid: false, errors, warnings: [] };
}

function invalidPlan(id: string, reason: string): ValidationError {
	return new ValidationError(`Plan "${id}": ${reason}`, {
		validationErrors: { valid: false, errors: [reason], warnings: [] },
	});
}

export class PlanStore {
	private readonly rootDir: string;
	private readonly plansDirName: string;

	constructor(options: PlanStoreOptions) {
		this.rootDir = options.rootDir;
		this.plansDirName = options.plansDirName ?? "plans";
	}

	/** Absolute path of the plans directory. */
	get plansDirPath(): string {
		return join(this.rootDir, this.plansDirName);
	}

	private assertSafeId(planId: string): void {
		if (!PLAN_ID_PATTERN.test(planId)) {
			throw this.invalidId(planId);
		}
	}

	private invalidId(planId: string): ValidationError {
		return invalidPlan(planId, `id is not a safe filename (must match ${PLAN_ID_PATTERN.source})`);
	}

	private filePath(planId: string): string {
		this.assertSafeId(planId);
		return join(this.plansDirPath, `${planId}.json`);
	}

	/**
	 * Persist a plan as the workspace's source of truth. Validates against
	 * `PlanSchema` first, creates the plans directory, and writes atomically
	 * (temp file + rename) so a crash never leaves a partial document.
	 */
	async save(plan: Plan): Promise<void> {
		const result = validatePlan(plan);
		if (!result.valid) {
			throw new ValidationError(`Cannot save plan "${plan.id}": schema validation failed`, {
				validationErrors: result,
			});
		}
		const target = this.filePath(plan.id);
		await fsMkdir(this.plansDirPath, { recursive: true });
		const tmp = join(this.plansDirPath, `.${plan.id}.tmp`);
		await fsWriteFile(tmp, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
		await fsRename(tmp, target);
	}

	/**
	 * Load a plan fresh from disk (read-through). Throws `NotFoundError` if the
	 * plan file does not exist and `ValidationError` if the on-disk content is
	 * unparseable or fails `PlanSchema` (an external edit that breaks the
	 * contract surfaces here, not silently).
	 */
	async load(planId: string): Promise<Plan> {
		const path = this.filePath(planId);
		let raw: string;
		try {
			raw = await fsReadFile(path, "utf8");
		} catch (error) {
			throw new NotFoundError(`Plan "${planId}" not found`, {
				resourceType: "plan",
				resourceId: planId,
				cause: toError(error),
			});
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw) as unknown;
		} catch (error) {
			throw invalidPlan(planId, `on-disk content is not valid JSON (${toError(error).message})`);
		}
		const result = validatePlan(parsed);
		if (!result.valid) {
			throw new ValidationError(`Plan "${planId}" on disk failed validation`, { validationErrors: result });
		}
		return parsed as Plan;
	}

	/** Whether a plan file exists on disk. */
	async exists(planId: string): Promise<boolean> {
		try {
			await fsAccess(this.filePath(planId));
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * List persisted plans. Returns a `PlanSummary` for each plan file that
	 * parses and validates; unparseable/invalid files are skipped (they fail
	 * loudly on `load` instead).
	 */
	async list(): Promise<PlanSummary[]> {
		const summaries: PlanSummary[] = [];
		let entries: string[];
		try {
			entries = await fsReaddir(this.plansDirPath);
		} catch {
			return summaries; // no plans directory yet
		}
		entries.sort((a, b) => a.localeCompare(b));
		for (const name of entries) {
			if (!name.endsWith(".json")) {
				continue;
			}
			const path = join(this.plansDirPath, name);
			let value: unknown;
			try {
				value = JSON.parse(await fsReadFile(path, "utf8")) as unknown;
			} catch {
				continue;
			}
			const result = validatePlan(value);
			if (!result.valid) {
				continue;
			}
			const plan = value as Plan;
			const stats = await fsStat(path).catch(() => null);
			summaries.push({
				id: plan.id,
				status: plan.status,
				version: plan.revisions.length > 0 ? plan.revisions[plan.revisions.length - 1]!.version : 1,
				updatedAt: plan.updatedAt,
				modifiedAt: stats?.mtimeMs ?? 0,
				taskCount: plan.tasks.length,
			});
		}
		return summaries;
	}

	/** Remove a plan file. Throws `NotFoundError` if it does not exist. */
	async delete(planId: string): Promise<void> {
		const path = this.filePath(planId);
		try {
			await fsRm(path, { force: false });
		} catch (error) {
			throw new NotFoundError(`Plan "${planId}" not found`, {
				resourceType: "plan",
				resourceId: planId,
				cause: toError(error),
			});
		}
	}

	/**
	 * Apply a change and record a revision — the full-document re-store per
	 * revision rule (§8). Loads the freshest on-disk doc, runs `mutate`,
	 * appends a `revision` with the next `version` and a refreshed `updatedAt`,
	 * then re-stores the whole document. Returns the saved plan.
	 */
	async revise(
		planId: string,
		reason: RevisionReason,
		changedTaskIds: TaskId[],
		mutate: (plan: Plan) => void,
	): Promise<Plan> {
		const plan = await this.load(planId);
		mutate(plan);
		const version = plan.revisions.length > 0 ? plan.revisions[plan.revisions.length - 1]!.version + 1 : 1;
		plan.updatedAt = Date.now();
		plan.revisions.push({ version, reason, changedTaskIds, createdAt: plan.updatedAt });
		await this.save(plan);
		return plan;
	}
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
