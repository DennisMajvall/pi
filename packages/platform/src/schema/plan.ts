/**
 * Plan Object Schemas
 *
 * Serializable TypeBox schemas for the canonical plan object (Step 2.1).
 * Constants only — the canonical TypeScript types live in `/plan/index.ts`.
 *
 * Enforced invariants:
 * - `Task` carries no execution state (§5): `additionalProperties: false`
 *   rejects any `status`/`priority`/`responsibleAgent` on a task.
 * - `requiredCapabilities` reuses `CapabilityIdSchema` (platform capability
 *   ids only, no free-text skill names).
 * - Numeric ranges (confidence/completeness/parallelism 0–100, integer
 *   counts/ranges) are encoded so out-of-range stage output fails validation.
 */

import { Type } from "typebox";
import {
	AssumptionSource,
	ConstraintKind,
	PlanningDepth,
	PlanRisk,
	PlanStatus,
	RevisionReason,
	TaskKind,
	VerificationLevel,
} from "../plan/index.ts";
import { CapabilityIdSchema } from "./shared.ts";

/** A clarification question raised during Goal Analysis (§9). */
export const ClarificationQuestionSchema = Type.Object(
	{
		question: Type.String(),
		blocking: Type.Boolean({ description: "High-priority unknown the Clarification Gate pauses on" }),
	},
	{ additionalProperties: false },
);

/** What the user wants. */
export const GoalSchema = Type.Object(
	{
		summary: Type.String(),
		successCriteria: Type.Array(Type.String()),
		unknowns: Type.Array(Type.String()),
		requiresClarification: Type.Boolean(),
		clarificationQuestions: Type.Array(ClarificationQuestionSchema),
	},
	{ additionalProperties: false },
);

/** An assumption the plan rests on. */
export const AssumptionSchema = Type.Object(
	{
		statement: Type.String(),
		confidence: Type.Number({ minimum: 0, maximum: 100, description: "0–100" }),
		source: Type.Union(Object.values(AssumptionSource).map((v) => Type.Literal(v))),
	},
	{ additionalProperties: false },
);

/** A limitation that influences planning. */
export const ConstraintSchema = Type.Object(
	{
		kind: Type.Union(Object.values(ConstraintKind).map((v) => Type.Literal(v))),
		description: Type.String(),
	},
	{ additionalProperties: false },
);

/** A discrete unit of work. Plan content only (§5): no execution fields. */
export const TaskSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, description: "Stable task id" }),
		title: Type.String(),
		purpose: Type.String(),
		deliverable: Type.String(),
		inputs: Type.Array(Type.String()),
		outputs: Type.Array(Type.String()),
		dependsOn: Type.Array(Type.String({ minLength: 1, description: "Task ids" })),
		requiredCapabilities: Type.Array(CapabilityIdSchema, {
			description: "Platform capability ids (e.g. tool.read, command.bash); no free-text skill names",
		}),
		verification: Type.String(),
	},
	{
		additionalProperties: false,
		description: "Plan-content task. Execution state (status/priority/responsibleAgent) is not permitted here (§5).",
	},
);

/** The strategy of the whole plan (§7). */
export const PlanningPolicySchema = Type.Object(
	{
		taskKind: Type.Union(Object.values(TaskKind).map((v) => Type.Literal(v))),
		planningDepth: Type.Union(Object.values(PlanningDepth).map((v) => Type.Literal(v))),
		hierarchicalRefinement: Type.Boolean(),
		parallelExecution: Type.Boolean(),
		specialistAgents: Type.Boolean(),
		requireApproval: Type.Boolean(),
		verificationLevel: Type.Union(Object.values(VerificationLevel).map((v) => Type.Literal(v))),
		preferResearch: Type.Boolean(),
		maxTasks: Type.Integer({ minimum: 1 }),
		dualPlanner: Type.Boolean(),
	},
	{ additionalProperties: false },
);

/** One entry in the git-like revision history (§8). */
export const RevisionSchema = Type.Object(
	{
		version: Type.Integer({ minimum: 1 }),
		reason: Type.Union(Object.values(RevisionReason).map((v) => Type.Literal(v))),
		changedTaskIds: Type.Array(Type.String({ minLength: 1, description: "Task ids" })),
		createdAt: Type.Number({ description: "Unix ms" }),
	},
	{ additionalProperties: false },
);

/** Quality metrics, set at review time (§14). */
export const MetricsSchema = Type.Object(
	{
		completeness: Type.Number({ minimum: 0, maximum: 100 }),
		confidence: Type.Number({ minimum: 0, maximum: 100 }),
		parallelism: Type.Number({ minimum: 0, maximum: 100, description: "DAG-derived: width / critical path" }),
		risk: Type.Union(Object.values(PlanRisk).map((v) => Type.Literal(v))),
		unknownCount: Type.Integer({ minimum: 0 }),
		missingInformation: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);

/** The canonical plan object — one schema, used by every stage. */
export const PlanSchema = Type.Object(
	{
		id: Type.String({ minLength: 1, description: "Plan id" }),
		schemaVersion: Type.Literal(1, { description: "Plan schema version; bump on breaking plan changes" }),
		goal: GoalSchema,
		policy: PlanningPolicySchema,
		constraints: Type.Array(ConstraintSchema),
		assumptions: Type.Array(AssumptionSchema),
		tasks: Type.Array(TaskSchema),
		revisions: Type.Array(RevisionSchema),
		status: Type.Union(Object.values(PlanStatus).map((v) => Type.Literal(v))),
		metrics: Type.Optional(MetricsSchema),
		createdAt: Type.Number({ description: "Unix ms" }),
		updatedAt: Type.Number({ description: "Unix ms" }),
	},
	{ additionalProperties: false },
);
