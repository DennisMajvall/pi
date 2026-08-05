/**
 * PlanViewComponent — pi-tui Component adapter for the PlanViewWidget (2.13.2).
 *
 * The thin terminal-binding layer that plugs the headless plan view into pi's
 * TUI the idiomatic way: an extension renders it via `ctx.ui.custom()`
 * (Step 2.13.3). It maps pi-tui key input to the widget's semantic actions and
 * triggers a re-render after each one, so navigation/edit/approve flow back
 * into the terminal.
 *
 * Key mapping is mode-aware: arrows/enter/escape/backspace always navigate;
 * in editing mode a printable character is appended to the directive buffer
 * (so "a"/"e"/"r" type into the edit, not trigger actions); in list/detail
 * modes `a` approves, `e` begins an edit, `r` refreshes.
 */

import type { PlanViewAction, PlanViewMode, PlanViewWidget } from "@earendil-works/pi-platform/planning";
import { type Component, Key, matchesKey, type TUI } from "@earendil-works/pi-tui";

/** A pi-tui component that renders and drives the plan view widget. */
export class PlanViewComponent implements Component {
	private readonly widget: PlanViewWidget;
	private readonly tui: TUI;

	constructor(widget: PlanViewWidget, tui: TUI) {
		this.widget = widget;
		this.tui = tui;
	}

	/** Render the current plan-view screen as plain lines (each ≤ width). */
	render(width: number): string[] {
		return this.widget.render(width);
	}

	handleInput(data: string): void {
		const action = keyToAction(data, this.widget.currentMode);
		if (!action) {
			return;
		}
		void this.widget.handle(action).then(() => this.tui.requestRender());
	}

	invalidate(): void {
		// Nothing cached: the widget recomputes its render on every call.
	}
}

/** Map a pi-tui key sequence to a semantic widget action, mode-aware. */
function keyToAction(data: string, mode: PlanViewMode): PlanViewAction | undefined {
	if (matchesKey(data, Key.up)) return { type: "up" };
	if (matchesKey(data, Key.down)) return { type: "down" };
	if (matchesKey(data, Key.enter)) return { type: "enter" };
	if (matchesKey(data, Key.escape)) return { type: "escape" };
	if (matchesKey(data, Key.backspace)) return { type: "backspace" };
	if (mode === "editing") {
		const ch = printableChar(data);
		return ch ? { type: "char", char: ch } : undefined;
	}
	if (matchesKey(data, "a")) return { type: "approve" };
	if (matchesKey(data, "e")) return { type: "edit" };
	if (matchesKey(data, "r")) return { type: "refresh" };
	return undefined;
}

/** A single printable (non-control) character, else undefined. */
function printableChar(data: string): string | undefined {
	if (data.length !== 1) {
		return undefined;
	}
	const code = data.charCodeAt(0);
	if (code < 32 || code === 127) {
		return undefined;
	}
	return data;
}
