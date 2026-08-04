/**
 * Generic planning stage (Step 2.3).
 *
 * A planning stage is an `orchestration`-category capability defined by a
 * stage contract (`systemPrompt` + `inputs` + `outputSchema`, Architecture
 * §6.2), run by the shared strict-JSON runner (validate → one retry → degrade,
 * §11), with per-stage model routing resolved independently of the session's
 * selected model. Every later stage (2.4+) follows this shape.
 *
 * `runStrictJsonStage` is the only way an AI stage produces output and is fully
 * implemented here (unit-tested with a fake completion); real AI stages bind a
 * model completion function into it.
 */

import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";
import type { CapabilityContext, CapabilityManifest } from "../capability/index.ts";
import type { SessionId } from "../identifier/index.ts";
import { capabilityId, capabilityVersion } from "../identifier/index.ts";
import type { BuiltinCapability } from "../kernel/discovery.ts";
import { PlanStore } from "../kernel/plan-store.ts";
import type { EventBusService } from "../service/index.ts";

/**
 * The generic stage contract (§6.2). `inputs` name the structured outputs of
 * prior stages a stage consumes — never the full conversation (§6.7).
 */
export interface PlanningStage<Out extends TSchema = TSchema> {
	/** Capability id: `<category>.<name>` (e.g. `orchestration.plan.create`). */
	id: string;
	category: "orchestration";
	name: string;
	description: string;
	/** AI stages only; deterministic stages (this step's trivial stage) omit it. */
	systemPrompt?: string;
	/** Structured inputs from prior stages. */
	inputs: readonly string[];
	/** Strict JSON output schema (validated by the runner / store). */
	outputSchema: Out;
	/** §11: optional stages are skipped, mandatory stages abort, on repeated failure. */
	mandatory: boolean;
	/** Model-routing key (defaults to the stage id). */
	modelKey?: string;
	/** Run the stage. Deterministic stages return output directly; AI stages call runStrictJsonStage. */
	run: (input: unknown, ctx: PlanningStageRunContext) => Promise<unknown>;
}

/** What a running stage receives: the workspace store plus the event bus. */
export interface PlanningStageRunContext {
	store: PlanStore;
	events: EventBusService;
	sessionId?: SessionId;
}

/**
 * Per-stage model routing: a mapping keyed by stage, resolved at the stage
 * contract level and explicitly independent of the session's selected model.
 */
export interface StageModelRouting {
	/** Model id used for stages without an explicit entry. */
	default: string;
	/** Stage key → model id overrides (real ids bound by the wiring in 2.4+). */
	stages?: Record<string, string>;
}

/** Placeholder routing establishing the shape; real model ids are bound later. */
export const DEFAULT_STAGE_MODEL_ROUTING: StageModelRouting = {
	default: "",
	stages: {},
};

/** Resolve the model a stage should run on. */
export function resolveStageModel(stageKey: string, routing: StageModelRouting): string {
	return routing.stages?.[stageKey] ?? routing.default;
}

/** A model completion function injected by the host (real model in 2.4+, fake in tests). */
export interface StageCompletionRequest {
	systemPrompt: string;
	userPrompt: string;
	model: string;
}
export type StageCompletion = (request: StageCompletionRequest) => Promise<string>;

/** Strict-JSON execution result (§11). */
export type StrictJsonResult<Out extends TSchema> =
	| { kind: "ok"; output: Static<Out>; attempts: number }
	| { kind: "degraded"; error?: string; attempts: number } // optional stage skipped
	| { kind: "aborted"; error: string; attempts: number }; // mandatory stage aborts with a diagnostic

export interface StrictJsonOptions<Out extends TSchema> {
	completion: StageCompletion;
	systemPrompt: string;
	userPrompt: string;
	outputSchema: Out;
	model: string;
	mandatory: boolean;
	/** Human-readable stage name for diagnostics (defaults to the schema's host). */
	stageName?: string;
}

/** Allowed max completion attempts (1 initial + 1 retry). */
const MAX_ATTEMPTS = 2;

/**
 * §11 stage isolation: parse the completion output as strict JSON and validate
 * against `outputSchema`; on failure retry once with the validation errors
 * appended to the prompt; on second failure skip if optional, abort if mandatory.
 */
export async function runStrictJsonStage<Out extends TSchema>(
	options: StrictJsonOptions<Out>,
): Promise<StrictJsonResult<Out>> {
	const stageName = options.stageName ?? "stage";
	let attempts = 0;
	let validationErrors: string[] = [];
	while (attempts < MAX_ATTEMPTS) {
		attempts++;
		const userPrompt = buildPrompt(options.userPrompt, validationErrors);
		const text = await options.completion({
			systemPrompt: options.systemPrompt,
			userPrompt,
			model: options.model,
		});
		const parsed = parseJsonStrict(text);
		if (parsed !== undefined && Value.Check(options.outputSchema, parsed)) {
			return { kind: "ok", output: parsed as Static<Out>, attempts };
		}
		validationErrors = collectValidationErrors(options.outputSchema, parsed === undefined ? text : parsed);
	}
	const error = validationErrors.length > 0 ? validationErrors.join("; ") : "non-JSON response";
	if (options.mandatory) {
		return {
			kind: "aborted",
			error: `${stageName} failed validation after ${MAX_ATTEMPTS} attempts: ${error}`,
			attempts,
		};
	}
	return { kind: "degraded", error: `${stageName} skipped after failed validation: ${error}`, attempts };
}

function buildPrompt(base: string, validationErrors: string[]): string {
	if (validationErrors.length === 0) {
		return base;
	}
	return `${base}\n\nYour previous output failed validation. Fix the JSON and return it only:\n${validationErrors
		.map((entry) => `- ${entry}`)
		.join("\n")}`;
}

function parseJsonStrict(text: string): unknown {
	const trimmed = text.trim();
	try {
		return JSON.parse(stripMarkdownFence(trimmed)) as unknown;
	} catch {
		return undefined;
	}
}

/** Strip an optional ```json ... ``` fence so a model that wraps JSON still parses. */
function stripMarkdownFence(text: string): string {
	const match = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
	return match ? (match[1] as string) : text;
}

function collectValidationErrors<Out extends TSchema>(schema: Out, value: unknown): string[] {
	const errors = Value.Errors(schema, value).map((error) => {
		const path = error instanceof Error && "instancePath" in error ? error.instancePath : "/";
		return `${path} ${error.message}`.trim();
	});
	return errors.length > 0 ? errors : ["output does not match the expected schema"];
}

/** The export a planning stage capability exposes (arbitrary per CapabilityExports). */
export interface PlanningStageExport {
	name: string;
	run: (input: unknown) => Promise<unknown>;
}

/**
 * Map a `PlanningStage` onto the platform capability pattern: a static manifest
 * (category `orchestration`, requiring `fs` + `events`) plus a factory whose
 * `init` builds the workspace-scoped PlanStore and exposes `{ stage }`.
 */
export function definePlanningStageCapability<Out extends TSchema>(stage: PlanningStage<Out>): BuiltinCapability {
	const manifest: CapabilityManifest = {
		schemaVersion: 1,
		id: capabilityId(stage.id),
		version: capabilityVersion("1.0.0"),
		category: "orchestration",
		provides: { orchestration: { name: stage.name } },
		requires: { services: ["fs", "events"], capabilities: [] },
		permissions: {},
		compatibility: { runtime: ">=0.83.0", peers: {} },
		metadata: { name: stage.name, description: stage.description, tags: ["planning"] },
	};
	return {
		manifest,
		factory: async (_ctx: CapabilityContext) => ({
			init: async (ctx) => {
				// The plan store is workspace-scoped (Step 2.2): rooted at the
				// injected FileSystemService's workspace root. Events flow over
				// the shared bus.
				const store = new PlanStore({ rootDir: ctx.fs.getWorkspaceRoot() });
				const run = async (input: unknown): Promise<unknown> => stage.run(input, { store, events: ctx.events });
				const exportValue: PlanningStageExport = { name: stage.name, run };
				return { stage: exportValue };
			},
			async shutdown() {
				// Nothing to release (the store is stateless; read-through).
			},
		}),
	};
}
