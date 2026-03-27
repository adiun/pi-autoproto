/**
 * pi-autocrit — Pi Extension
 *
 * Persona-driven UX evaluation loop for web app prototypes.
 * Build, evaluate with synthetic users, iterate on feedback.
 *
 * Provides:
 * - `init_autocrit` tool — validates dependencies, sets up workspace
 * - `run_evaluation` tool — wraps evaluate.py, returns structured results
 * - `log_iteration` tool — records results, manages history files
 * - `generate_report` tool — comparative synthesis across prototypes
 * - Dashboard widget showing iteration progress and scores
 * - `/autocrit` command for status and control
 * - System prompt injection with autocrit context
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	createRuntime,
	reconstructState,
	currentBranchIterations,
	latestIteration,
	bestIteration,
	isPlateaued,
	type AutocritRuntime,
} from "./state.js";
import { formatScoreLine } from "./utils.js";
import { renderCompactWidget, renderExpandedWidget } from "./widget.js";
import { registerInitTool } from "./tools/init.js";
import { registerEvaluateTool } from "./tools/evaluate.js";
import { registerLogTool } from "./tools/log.js";
import { registerReportTool } from "./tools/report.js";

export default function autocritExtension(pi: ExtensionAPI): void {
	let runtime: AutocritRuntime = createRuntime();
	let dashboardExpanded = false;

	const getRuntime = () => runtime;

	// -------------------------------------------------------------------
	// Tools
	// -------------------------------------------------------------------

	registerInitTool(pi, getRuntime);
	registerEvaluateTool(pi, getRuntime);
	registerLogTool(pi, getRuntime);
	registerReportTool(pi, getRuntime);

	// -------------------------------------------------------------------
	// Widget
	// -------------------------------------------------------------------

	function updateWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;

		const state = runtime.state;
		if (!state.active || state.iterations.length === 0) {
			if (state.active) {
				// Active but no iterations yet — show minimal status
				ctx.ui.setWidget("autocrit", (_tui, theme) => {
					const parts = [
						theme.fg("accent", "🎯"),
						theme.fg("muted", ` autocrit`),
					];
					if (state.experimentName) {
						parts.push(theme.fg("dim", `: ${state.experimentName}`));
					}
					parts.push(theme.fg("dim", " — waiting for first evaluation"));
					return new Text(parts.join(""), 0, 0);
				});
			} else {
				ctx.ui.setWidget("autocrit", undefined);
			}
			return;
		}

		if (dashboardExpanded) {
			ctx.ui.setWidget("autocrit", (_tui, theme) =>
				renderExpandedWidget(state, theme),
			);
		} else {
			ctx.ui.setWidget("autocrit", (_tui, theme) =>
				renderCompactWidget(state, theme),
			);
		}
	}

	// -------------------------------------------------------------------
	// Keyboard shortcut — toggle dashboard expand/collapse
	// -------------------------------------------------------------------

	pi.registerShortcut("ctrl+x", {
		description: "Toggle autocrit dashboard expand/collapse",
		handler: async (ctx) => {
			if (!runtime.state.active) return;
			dashboardExpanded = !dashboardExpanded;
			updateWidget(ctx);
		},
	});

	// -------------------------------------------------------------------
	// /autocrit command
	// -------------------------------------------------------------------

	pi.registerCommand("autocrit", {
		description: "Autocrit status and control (start/status/off)",
		handler: async (args, ctx) => {
			const subcommand = args?.trim().toLowerCase();

			if (subcommand === "off") {
				runtime.state.active = false;
				ctx.ui.setWidget("autocrit", undefined);
				ctx.ui.setStatus("autocrit", undefined);
				ctx.ui.notify("Autocrit mode disabled.", "info");
				return;
			}

			if (subcommand === "start") {
				ctx.ui.notify("Use /skill:autocrit to start a new autocrit session, or call init_autocrit.", "info");
				return;
			}

			// Default: show status
			const state = runtime.state;
			if (!state.active) {
				ctx.ui.notify("Autocrit is not active. Use /skill:autocrit or init_autocrit to start.", "info");
				return;
			}

			const iters = currentBranchIterations(state);
			const latest = latestIteration(state);
			const best = bestIteration(state);

			let status = `Autocrit: ${state.experimentName ?? "unnamed"} (${state.mode} mode)\n`;
			status += `Branch: ${state.currentBranch ?? "—"}\n`;
			status += `Iterations: ${iters.length} (${iters.filter((r) => r.kept).length} kept)\n`;

			if (latest) {
				status += `Latest: iter ${latest.iteration} — ${formatScoreLine(state)}\n`;
			}
			if (best) {
				status += `Best: iter ${best.iteration} — composite ${best.composite.toFixed(1)}\n`;
			}
			if (isPlateaued(state)) {
				status += "⚠️ Plateau detected\n";
			}

			ctx.ui.notify(status, "info");
		},
	});

	// -------------------------------------------------------------------
	// System prompt injection
	// -------------------------------------------------------------------

	pi.on("before_agent_start", async (event, ctx) => {
		if (!runtime.state.active) return;

		const state = runtime.state;
		const latest = latestIteration(state);

		let extra = "\n\n## Autocrit Mode (ACTIVE)";
		extra += "\nYou are in autocrit mode — iterating on a web app prototype with persona-driven evaluation.";
		extra += "\nUse init_autocrit, run_evaluation, log_iteration, and generate_report tools.";
		extra += "\nRead the autocrit skill (/skill:autocrit) for the full workflow.";

		if (latest) {
			extra += `\n\nCurrent state: iteration ${latest.iteration}, ${state.currentBranch ?? "—"}, composite ${latest.composite.toFixed(1)}`;
			extra += ` (P0: ${latest.p0.toFixed(1)} P1: ${latest.p1.toFixed(1)} P2: ${latest.p2.toFixed(1)})`;
		}

		if (isPlateaued(state)) {
			extra += "\n\n⚠️ PLATEAU DETECTED — consider stopping and running final evaluation with mode 'variants'.";
		}

		return {
			systemPrompt: event.systemPrompt + extra,
		};
	});

	// -------------------------------------------------------------------
	// Session lifecycle
	// -------------------------------------------------------------------

	const loadState = async (_event: unknown, ctx: ExtensionContext) => {
		runtime = createRuntime();
		runtime.state = reconstructState(ctx.cwd);

		// Try to detect current git branch
		try {
			const result = await pi.exec("git", ["branch", "--show-current"]);
			if (result.code === 0 && result.stdout) {
				runtime.state.currentBranch = result.stdout.trim();
			}
		} catch {
			// not in a git repo
		}

		updateWidget(ctx);
	};

	pi.on("session_start", loadState);
	pi.on("session_switch", loadState);
	pi.on("session_fork", loadState);

	// Update widget after each tool execution (scores may have changed)
	pi.on("tool_execution_end", async (_event, ctx) => {
		updateWidget(ctx);
	});

	// Update status in footer
	pi.on("turn_end", async (_event, ctx) => {
		if (!runtime.state.active) {
			ctx.ui.setStatus("autocrit", undefined);
			return;
		}

		const latest = latestIteration(runtime.state);
		if (latest) {
			const plateauFlag = isPlateaued(runtime.state) ? " ⚠️" : "";
			ctx.ui.setStatus(
				"autocrit",
				ctx.ui.theme.fg("accent", `🎯 iter ${latest.iteration} │ ${latest.composite.toFixed(1)}${plateauFlag}`),
			);
		} else {
			ctx.ui.setStatus("autocrit", ctx.ui.theme.fg("dim", "🎯 autocrit"));
		}
	});

	// Cleanup on shutdown — kill cached dev server and clear UI
	pi.on("session_shutdown", async (_event, ctx) => {
		if (runtime.devServerCleanup) {
			await runtime.devServerCleanup();
			runtime.devServerPort = null;
			runtime.devServerCleanup = null;
		}
		ctx.ui.setWidget("autocrit", undefined);
		ctx.ui.setStatus("autocrit", undefined);
	});
}
