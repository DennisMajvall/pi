/**
 * Plan View extension (Step 2.13.3).
 *
 * Registers the `/plans` command that opens the plan review surface in the TUI
 * via `ctx.ui.custom()` — the idiomatic "modify pi's TUI" path used by public
 * extensions. The surface is the `PlanViewWidget` (2.13.2) wrapped by
 * `PlanViewComponent`, driven by a `PlanCapabilityRunner` (2.13.1) rooted at the
 * workspace plan store (`<workspace>/plans`). Esc from the top of the list
 * returns to chat.
 */

import { capabilityId } from "@earendil-works/pi-platform/identifier";
import { PlanStore } from "@earendil-works/pi-platform/kernel";
import {
	createPlanCapabilityRunner,
	type PlanCapabilityRunner,
	PlanViewWidget,
} from "@earendil-works/pi-platform/planning";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { getPlatformRuntime } from "../../platform/platform-runtime.ts";
import { PlanViewComponent } from "./plan-view-component.ts";

const READ_CAPABILITY_ID = capabilityId("tool.read");

/**
 * Build the plan review runner over the workspace plan store (read-through).
 * Returns undefined if the platform runtime (or its workspace root) is not
 * available — the command reports that instead of failing.
 */
function workspacePlanRunner(): PlanCapabilityRunner | undefined {
	const kernel = getPlatformRuntime();
	const context = kernel?.capabilities.getContext(READ_CAPABILITY_ID);
	const root = context?.fs.getWorkspaceRoot();
	if (!kernel || !root) {
		return undefined;
	}
	const store = new PlanStore({ rootDir: root });
	return createPlanCapabilityRunner({ store, events: kernel.events });
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
}
