/**
 * Plan View + `/plan` generation extension (Step 2.13.3/2.13.5).
 *
 * `/plans` opens the plan review surface in the TUI via `ctx.ui.custom()` — the
 * idiomatic "modify pi's TUI" path used by public extensions. The surface is the
 * `PlanViewWidget` (2.13.2) wrapped by `PlanViewComponent`, driven by a
 * `PlanCapabilityRunner` (2.13.1) rooted at the workspace plan store
 * (`<workspace>/plans`). Esc from the top of the list returns to chat.
 *
 * `/plan <request>` runs the real planning pipeline (`runPlanningPipeline`) for
 * a request, binding the AI stages to the session's model (`ctx.modelRuntime`
 * exposed on `ExtensionContext` for this), and persists the approved plan to the
 * workspace store — which `/plans` then lists via read-through.
 */

import { type Context, contentText, type Model } from "@earendil-works/pi-ai";
import { capabilityId, taskId } from "@earendil-works/pi-platform/identifier";
import { PlanStore } from "@earendil-works/pi-platform/kernel";
import type { Plan } from "@earendil-works/pi-platform/plan";
import {
	appendPlanRevision,
	ClarificationRequiredError,
	constraintExtractionStage,
	createPlanCapabilityRunner,
	criticStage,
	executionStrategyStage,
	goalAnalysisStage,
	metricsStage,
	optimizerStage,
	type PlanCapabilityRunner,
	type PlanEdit,
	type PlanViewStyle,
	PlanViewWidget,
	parsePlanEdit,
	runPlanningPipeline,
	runStrictJsonStage,
	type StageCompletion,
	type StageModelRouting,
	taskDecompositionStage,
	ValidationIssueCode,
	validatePlan,
} from "@earendil-works/pi-platform/planning";
import { PlanSchema } from "@earendil-works/pi-platform/schema";
import type { EventBusService } from "@earendil-works/pi-platform/service";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { getPlatformRuntime } from "../../platform/platform-runtime.ts";
import { PlanViewComponent } from "./plan-view-component.ts";

/** Map a theme color name for a plan lifecycle status. */
function statusColor(status: string): "success" | "warning" | "accent" | "error" | "muted" | "dim" {
	switch (status) {
		case "approved":
			return "success";
		case "completed":
			return "success";
		case "needs_review":
			return "warning";
		case "replanning":
			return "warning";
		case "running":
			return "accent";
		case "failed":
			return "error";
		case "archived":
			return "dim";
		default:
			return "muted";
	}
}

/** Build the plan view text stylers from the active TUI theme. */
function themeToPlanStyle(theme: Theme): PlanViewStyle {
	return {
		title: (text) => theme.fg("accent", theme.bold(text)),
		heading: (text) => theme.fg("mdHeading", theme.bold(text)),
		label: (text) => theme.fg("toolTitle", text),
		id: (text) => theme.fg("accent", text),
		status: (text) => theme.fg(statusColor(text.slice(1, -1)), text),
		bullet: (text) => theme.fg("mdListBullet", text),
		selected: (text) => theme.fg("warning", theme.bold(text)),
		dim: (text) => theme.fg("dim", text),
	};
}

const READ_CAPABILITY_ID = capabilityId("tool.read");

/**
 * The workspace plan store + event bus (read-through), or undefined if the
 * platform runtime (or its workspace root) is not available.
 */
function workspacePlanDeps(): { store: PlanStore; events: EventBusService } | undefined {
	const kernel = getPlatformRuntime();
	const context = kernel?.capabilities.getContext(READ_CAPABILITY_ID);
	const root = context?.fs.getWorkspaceRoot();
	if (!kernel || !root) {
		return undefined;
	}
	return { store: new PlanStore({ rootDir: root }), events: kernel.events };
}

/** Build the plan review runner over the workspace plan store (read-through). */
function workspacePlanRunner(): PlanCapabilityRunner | undefined {
	const deps = workspacePlanDeps();
	return deps ? createPlanCapabilityRunner({ store: deps.store, events: deps.events }) : undefined;
}

/**
 * A `StageCompletion` bound to the agent's model: builds a pi-ai context and
 * calls `modelRuntime.completeSimple`. Minimal — strict-JSON compliance is left
 * to the platform runner (schema grounding + validate/retry/degrade, 2.12); no
 * API-side JSON mode is requested.
 */
export function createStageCompletion(modelRuntime: ModelRuntime, model: Model<any>): StageCompletion {
	return async ({ systemPrompt, userPrompt }) => {
		const context: Context = {
			systemPrompt,
			messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
		};
		const message = await modelRuntime.completeSimple(model, context);
		return contentText(message.content);
	};
}

/** Options for `generatePlan`. */
export interface GeneratePlanOptions {
	request: string;
	store: PlanStore;
	events: EventBusService;
	modelRuntime: ModelRuntime;
	model: Model<any>;
	/** Answers to the goal's clarification questions (question → answer). */
	clarifyAnswers?: Record<string, string>;
}

/**
 * Run the full planning pipeline for a request on the session model and return
 * the approved, persisted plan. All AI stages route to `options.model` (per-stage
 * routing from settings is a documented follow-up).
 */
export async function generatePlan(options: GeneratePlanOptions): Promise<Plan> {
	const completion = createStageCompletion(options.modelRuntime, options.model);
	const routing: StageModelRouting = { default: options.model.id };
	const stages = {
		goal: goalAnalysisStage(completion, routing),
		strategy: executionStrategyStage(completion, routing),
		constraints: constraintExtractionStage(completion, routing),
		tasks: taskDecompositionStage(completion, routing),
		critic: criticStage(completion, routing),
		optimizer: optimizerStage(completion, routing),
		metrics: metricsStage(completion, routing),
	};
	const result = await runPlanningPipeline(options.request, stages, {
		store: options.store,
		events: options.events,
		...(options.clarifyAnswers ? { clarifyAnswers: options.clarifyAnswers } : {}),
	});
	return result.plan;
}

/** True when the deterministic directive parser did not recognize a directive. */
function isUnsupportedDirectiveError(error: unknown): boolean {
	return error instanceof Error && error.message.includes("unsupported directive");
}

/** Task ids whose content differs between an original and an edited plan (for the revision). */
function changedTaskIdsBetween(original: Plan, edited: Plan): string[] {
	const byId = new Map(original.tasks.map((t) => [String(t.id), t]));
	const changed = new Set<string>();
	for (const t of edited.tasks) {
		const orig = byId.get(String(t.id));
		if (!orig || JSON.stringify(orig) !== JSON.stringify(t)) {
			changed.add(String(t.id));
		}
	}
	for (const t of original.tasks) {
		if (!edited.tasks.some((e) => String(e.id) === String(t.id))) {
			changed.add(String(t.id));
		}
	}
	return [...changed];
}

/** Options for the AI-driven plan edit fallback. */
export interface AiEditPlanOptions {
	plan: Plan;
	directive: string;
	store: PlanStore;
	modelRuntime: ModelRuntime;
	model: Model<any>;
}

/**
 * Apply a free-form conversational edit directive via the model and persist the
 * result, recording a `user_edit` revision. The model returns the full edited
 * plan as strict JSON, validated against `PlanSchema` and the DAG invariants
 * before saving.
 */
export async function aiEditPlan(options: AiEditPlanOptions): Promise<Plan> {
	const completion = createStageCompletion(options.modelRuntime, options.model);
	const systemPrompt =
		"You are Pi's plan editor. Apply the user's requested change to the existing plan " +
		"and return the FULL edited plan as valid JSON matching the Plan schema exactly. " +
		"Keep every field the change does not affect identical to the input plan, and " +
		"preserve the dependency DAG (dependsOn must reference existing task ids, no cycles).";
	const result = await runStrictJsonStage({
		completion,
		systemPrompt,
		userPrompt: [
			"<directive>",
			options.directive,
			"</directive>",
			"",
			"<current_plan>",
			JSON.stringify(options.plan),
			"</current_plan>",
		].join("\n"),
		outputSchema: PlanSchema,
		model: options.model.id,
		mandatory: true,
		stageName: "plan edit",
	});
	if (result.kind !== "ok") {
		throw new Error(result.error ?? "plan edit failed");
	}
	const edited = result.output as unknown as Plan;
	// Hard-fail only on schema/cycle/dangling-ref issues; coverage issues
	// (unreachable criterion, missing purpose, duplicate deliverable) are
	// non-fatal and persist — matching the planning pipeline's behavior.
	const validation = validatePlan(edited);
	const hardIssues = validation.issues.filter(
		(issue) => issue.code === ValidationIssueCode.Schema || issue.code === ValidationIssueCode.Cycle,
	);
	const taskIds = new Set(edited.tasks.map((t) => String(t.id)));
	for (const task of edited.tasks) {
		for (const dep of task.dependsOn) {
			if (!taskIds.has(String(dep))) {
				hardIssues.push({
					code: ValidationIssueCode.Schema,
					message: `task ${task.id} depends on missing task ${dep}`,
				});
			}
		}
	}
	if (hardIssues.length > 0) {
		throw new Error(
			`plan edit produced an invalid plan: ${hardIssues.map((i) => i.message).join("; ") || "unknown issue"}`,
		);
	}
	const changed = changedTaskIdsBetween(options.plan, edited).map((id) => taskId(id));
	const withRevision = appendPlanRevision(edited, "user_edit", changed);
	await options.store.save(withRevision);
	return withRevision;
}

/**
 * Wrap a deterministic runner so `edit` falls back to the model when the
 * deterministic directive parser does not recognize the instruction.
 */
function withAiEditFallback(
	runner: PlanCapabilityRunner,
	options: Omit<AiEditPlanOptions, "plan" | "directive">,
): PlanCapabilityRunner {
	return {
		...runner,
		async edit(planId: string, edit: PlanEdit | string): Promise<Plan> {
			if (typeof edit !== "string") {
				return runner.edit(planId, edit);
			}
			const plan = await runner.load(planId);
			try {
				const parsed = parsePlanEdit(edit, plan);
				return runner.edit(planId, parsed);
			} catch (error) {
				if (!isUnsupportedDirectiveError(error)) {
					throw error;
				}
			}
			return aiEditPlan({ ...options, plan, directive: edit });
		},
	};
}

/**
 * Build a prompt that instructs the agent to execute a plan in the normal chat
 * view, working through its tasks with the usual tools and showing progress.
 */
function buildExecutePrompt(plan: Plan): string {
	const version = plan.revisions.length > 0 ? plan.revisions[plan.revisions.length - 1]!.version : 1;
	const taskLines = plan.tasks.map((t) =>
		[
			`## ${t.id}: ${t.title}`,
			`Purpose: ${t.purpose}`,
			`Deliverable: ${t.deliverable}`,
			`Depends on: ${t.dependsOn.length > 0 ? t.dependsOn.join(", ") : "(none)"}`,
			`Verification: ${t.verification.trim().length > 0 ? t.verification : "(none)"}`,
		].join("\n"),
	);
	return [
		`Please execute the plan "${plan.goal.summary}" (id ${plan.id}, v${version}, status ${plan.status}).`,
		"",
		`Requirement: ${plan.goal.summary}`,
		"",
		"Tasks (work through them, respecting dependencies):",
		"",
		...taskLines,
		"",
		"For each task, carry it out with the appropriate tools, verify it against its Verification/",
		"Deliverable before moving on, and give a short summary when each task is done and when the",
		"whole plan is complete.",
	].join("\n");
}

/** Collect answers to a goal's blocking clarification questions (TUI input dialogs). */
async function collectClarification(
	ctx: ExtensionCommandContext,
	questions: readonly { question: string; blocking: boolean }[],
): Promise<Record<string, string> | undefined> {
	const answers: Record<string, string> = {};
	for (let i = 0; i < questions.length; i++) {
		const q = questions[i]!;
		const answer = await ctx.ui.input(`(${i + 1}/${questions.length}) ${q.question}`, "answer");
		if (answer === undefined || answer.trim().length === 0) {
			return undefined; // user cancelled
		}
		answers[q.question] = answer.trim();
	}
	return answers;
}

export default function planViewExtension(pi: ExtensionAPI): void {
	pi.registerCommand("plans", {
		description: "View, edit, and approve plans in the TUI",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/plans is available in interactive mode", "warning");
				return;
			}
			const runner = workspacePlanRunner();
			if (!runner) {
				ctx.ui.notify("Platform runtime is not available", "warning");
				return;
			}
			const deps = workspacePlanDeps();
			const model = ctx.model;
			const modelRuntime = ctx.modelRuntime;
			// When a model is available, fall back to it for directives the
			// deterministic parser does not recognize. Otherwise edits stay
			// deterministic.
			const editRunner =
				deps && modelRuntime && model
					? withAiEditFallback(runner, {
							store: deps.store,
							modelRuntime,
							model,
						})
					: runner;
			await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
				const widget = new PlanViewWidget({
					runner: editRunner,
					onClose: () => done(),
					onExecute: (plan) => {
						// Hand off to the normal chat view so the agent runs the plan
						// with the usual thought process, tools, and interactivity.
						done();
						if (ctx.isIdle()) {
							pi.sendUserMessage(buildExecutePrompt(plan));
						} else {
							ctx.ui.notify("Agent is busy; queued to run after the current turn.", "info");
							pi.sendUserMessage(buildExecutePrompt(plan), { deliverAs: "followUp" });
						}
					},
					style: themeToPlanStyle(theme),
				});
				return widget.initialize().then(() => new PlanViewComponent(widget, tui));
			});
		},
	});

	pi.registerCommand("plan", {
		description: "Plan <request> — run planning and persist an approved plan (see /plans)",
		handler: async (args, ctx: ExtensionCommandContext) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/plan is available in interactive mode", "warning");
				return;
			}
			const model = ctx.model;
			const deps = workspacePlanDeps();
			const request = (args ?? "").trim();
			if (!ctx.modelRuntime) {
				ctx.ui.notify("Model runtime is not available here", "warning");
				return;
			}
			if (!model) {
				ctx.ui.notify("No model is configured; use /model first", "warning");
				return;
			}
			if (!deps) {
				ctx.ui.notify("Platform runtime is not available", "warning");
				return;
			}
			if (!request) {
				ctx.ui.notify("Usage: /plan <request>", "warning");
				return;
			}
			ctx.ui.notify(`Planning: ${request.slice(0, 60)}…`, "info");
			const base: GeneratePlanOptions = {
				request,
				store: deps.store,
				events: deps.events,
				modelRuntime: ctx.modelRuntime,
				model,
			};
			const modelLabel = `${model.provider ?? ""}/${model.id}`.replace(/^\//, "");
			// The working row is gated on agent streaming, which /plan does not do
			// (it runs completions directly), so show the loading state as footer
			// status text via ui.setStatus — visible regardless of streaming.
			const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
			let spinIndex = 0;
			let statusTimer: ReturnType<typeof setInterval> | undefined;
			const startLoading = (): void => {
				ctx.ui.setStatus("planning", `Planning with ${modelLabel}: ${request.slice(0, 60)}…`);
				if (statusTimer) clearInterval(statusTimer);
				statusTimer = setInterval(() => {
					spinIndex = (spinIndex + 1) % spinner.length;
					ctx.ui.setStatus(
						"planning",
						`${spinner[spinIndex]} Planning with ${modelLabel}: ${request.slice(0, 60)}…`,
					);
				}, 120);
			};
			const clearLoading = (): void => {
				if (statusTimer) clearInterval(statusTimer);
				statusTimer = undefined;
				ctx.ui.setStatus("planning", undefined);
			};
			try {
				startLoading();
				const plan = await generatePlan(base);
				ctx.ui.notify(`Plan ${plan.id} approved — open with /plans`, "info");
			} catch (error) {
				if (error instanceof ClarificationRequiredError) {
					ctx.ui.notify("The goal needs a few answers before planning can continue…", "info");
					const answers = await collectClarification(ctx, error.questions);
					if (!answers) {
						ctx.ui.notify("Planning cancelled", "warning");
						return;
					}
					try {
						startLoading();
						const plan = await generatePlan({ ...base, clarifyAnswers: answers });
						ctx.ui.notify(`Plan ${plan.id} approved — open with /plans`, "info");
					} catch (retryError) {
						ctx.ui.notify(retryError instanceof Error ? retryError.message : String(retryError), "error");
					} finally {
						clearLoading();
					}
					return;
				}
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			} finally {
				clearLoading();
			}
		},
	});
}
