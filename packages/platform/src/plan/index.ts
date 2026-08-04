/**
 * Plan Contracts
 *
 * The canonical plan object for the Planning skill (ROADMAP Step 2).
 *
 * One schema, used by every stage that reads or writes plans. The plan is the
 * persisted, versioned artifact (revisions); it is deliberately distinct from
 * the runtime-owned execution overlay. Per Architecture §5, plan content and
 * execution state never mix: `Task` carries no `status`/`priority`/
 * `responsibleAgent` — those live in the execution overlay.
 *
 * This module holds the canonical TypeScript types and const objects; the
 * serializable TypeBox schemas live in `/schema/plan.ts` (constants only).
 */

import type { CapabilityId, PlanId, TaskId } from "../identifier/index.ts";

/** Delivery strategy of the request being planned. */
export const TaskKind = {
	Research: "research",
	Implementation: "implementation",
	Debugging: "debugging",
	Design: "design",
	Maintenance: "maintenance",
	Mixed: "mixed",
} as const;
export type TaskKind = (typeof TaskKind)[keyof typeof TaskKind];

/** How deep and thorough planning should be. */
export const PlanningDepth = {
	Low: "low",
	Medium: "medium",
	High: "high",
} as const;
export type PlanningDepth = (typeof PlanningDepth)[keyof typeof PlanningDepth];

/** Per-task verification strictness. */
export const VerificationLevel = {
	None: "none",
	Basic: "basic",
	Strict: "strict",
} as const;
export type VerificationLevel = (typeof VerificationLevel)[keyof typeof VerificationLevel];

/** Where an assumption came from. */
export const AssumptionSource = {
	User: "user",
	Verified: "verified",
	Inferred: "inferred",
} as const;
export type AssumptionSource = (typeof AssumptionSource)[keyof typeof AssumptionSource];

/** Constraint family. */
export const ConstraintKind = {
	Hard: "hard",
	Soft: "soft",
	Resource: "resource",
	Policy: "policy",
} as const;
export type ConstraintKind = (typeof ConstraintKind)[keyof typeof ConstraintKind];

/** Plan lifecycle status (§8). The architecture only permits it on the Plan. */
export const PlanStatus = {
	Draft: "draft",
	NeedsReview: "needs_review",
	Approved: "approved",
	Running: "running",
	Replanning: "replanning",
	Completed: "completed",
	Failed: "failed",
	Archived: "archived",
} as const;
export type PlanStatus = (typeof PlanStatus)[keyof typeof PlanStatus];

/** Why a revision was created (§8). */
export const RevisionReason = {
	UserEdit: "user_edit",
	Critic: "critic",
	Optimizer: "optimizer",
	Replan: "replan",
	Approval: "approval",
} as const;
export type RevisionReason = (typeof RevisionReason)[keyof typeof RevisionReason];

/** Subjective risk assessment (§14). */
export const PlanRisk = {
	Low: "low",
	Medium: "medium",
	High: "high",
} as const;
export type PlanRisk = (typeof PlanRisk)[keyof typeof PlanRisk];

/**
 * A clarification question raised during Goal Analysis (§9).
 * `blocking` marks the high-priority unknowns the deterministic Clarification
 * Gate pauses on.
 */
export interface ClarificationQuestion {
	question: string;
	blocking: boolean;
}

/** What the user wants: one summary + success criteria + unknowns. */
export interface Goal {
	summary: string;
	successCriteria: string[];
	unknowns: string[];
	requiresClarification: boolean;
	clarificationQuestions: ClarificationQuestion[];
}

/** An assumption the plan rests on, with provenance and confidence. */
export interface Assumption {
	statement: string;
	confidence: number;
	source: AssumptionSource;
}

/** A limitation that influences planning. */
export interface Constraint {
	kind: ConstraintKind;
	description: string;
}

/**
 * A discrete unit of work. Plan content only — per §5 it carries no execution
 * state (no `status`/`priority`/`responsibleAgent`).
 */
export interface Task {
	/** Stable task id (survives replanning of unrelated tasks). */
	id: TaskId;
	title: string;
	/** Why this task exists. */
	purpose: string;
	/** What "done" produces; used by the Dependency Builder edge rules. */
	deliverable: string;
	/** Artifacts/values consumed. */
	inputs: string[];
	/** Artifacts/values produced. */
	outputs: string[];
	/** Dependent task ids; derived from Dependency Builder edges (DAG). */
	dependsOn: TaskId[];
	/** Platform capability ids (e.g. `tool.read`, `command.bash`); resolved at execution. */
	requiredCapabilities: CapabilityId[];
	/** How completion is verified. */
	verification: string;
}

/** The strategy of the whole plan; produced once by Execution Strategy Selection (§7). */
export interface PlanningPolicy {
	taskKind: TaskKind;
	planningDepth: PlanningDepth;
	hierarchicalRefinement: boolean;
	parallelExecution: boolean;
	specialistAgents: boolean;
	requireApproval: boolean;
	verificationLevel: VerificationLevel;
	preferResearch: boolean;
	maxTasks: number;
	dualPlanner: boolean;
}

/** One entry in the git-like revision history (§8). */
export interface Revision {
	version: number;
	reason: RevisionReason;
	changedTaskIds: TaskId[];
	createdAt: number;
}

/** Quality metrics, set at review time (§14). */
export interface Metrics {
	completeness: number;
	confidence: number;
	/** DAG-derived (width / critical path), 0–100. */
	parallelism: number;
	risk: PlanRisk;
	unknownCount: number;
	missingInformation: string[];
}

/** A plan type (versioned, persisted plan content — see module doc). */
export interface Plan {
	id: PlanId;
	schemaVersion: 1;
	goal: Goal;
	policy: PlanningPolicy;
	constraints: Constraint[];
	assumptions: Assumption[];
	tasks: Task[];
	revisions: Revision[];
	status: PlanStatus;
	metrics?: Metrics;
	createdAt: number;
	updatedAt: number;
}
