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
import { capabilityId } from "@earendil-works/pi-platform/identifier";
import { PlanStore } from "@earendil-works/pi-platform/kernel";
import type { Plan } from "@earendil-works/pi-platform/plan";
import {
	ClarificationRequiredError,
	constraintExtractionStage,
	createPlanCapabilityRunner,
	criticStage,
	executionStrategyStage,
	goalAnalysisStage,
	metricsStage,
	optimizerStage,
	type PlanCapabilityRunner,
	PlanViewWidget,
	runPlanningPipeline,
	type StageCompletion,
	type StageModelRouting,
	taskDecompositionStage,
} from "@earendil-works/pi-platform/planning";
import type { EventBusService } from "@earendil-works/pi-platform/service";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { ModelRuntime } from "../../core/model-runtime.ts";
import { getPlatformRuntime } from "../../platform/platform-runtime.ts";
import { PlanViewComponent } from "./plan-view-component.ts";

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
			await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
				const widget = new PlanViewWidget({ runner, onClose: () => done() });
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
