/**
 * pi-autoproto — Pi Extension
 *
 * Persona-driven UX evaluation loop for web app prototypes.
 * Build, evaluate with synthetic users, iterate on feedback.
 *
 * Provides:
 * - `init_autoproto` tool — validates dependencies, sets up workspace
 * - `run_evaluation` tool — wraps evaluate.py, returns structured results
 * - `log_iteration` tool — records results, manages history files
 * - `generate_report` tool — comparative synthesis across prototypes
 * - Dashboard widget showing iteration progress and scores
 * - `/autoproto` command for status and control
 * - System prompt injection with autoproto context
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
	type AutoprotoRuntime,
} from "./state.js";
import { formatScoreLine, formatDuration, getElapsedMs } from "./utils.js";
import { renderCompactWidget, renderExpandedWidget, renderFullscreenWidget, type IterationFeedbackData } from "./widget.js";
import { registerInitTool } from "./tools/init.js";
import { registerEvaluateTool } from "./tools/evaluate.js";
import { registerLogTool } from "./tools/log.js";
import { registerReportTool } from "./tools/report.js";

export default function autoprotoExtension(pi: ExtensionAPI): void {
	let runtime: AutoprotoRuntime = createRuntime();
	let dashboardMode: "compact" | "expanded" | "fullscreen" = "compact";

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
				ctx.ui.setWidget("autoproto", (_tui, theme) => {
					const parts = [
						theme.fg("accent", "🎯"),
						theme.fg("muted", ` autoproto`),
					];
					if (state.experimentName) {
						parts.push(theme.fg("dim", `: ${state.experimentName}`));
					}
					parts.push(theme.fg("dim", " — waiting for first evaluation"));
					return new Text(parts.join(""), 0, 0);
				});
			} else {
				ctx.ui.setWidget("autoproto", undefined);
			}
			return;
		}

		if (dashboardMode === "fullscreen") {
			// Read feedback data from evaluation results on disk
			const feedbackData: IterationFeedbackData[] = [];
			const resultsDir = state.resultsDir ?? "results";
			const itersForFeedback = currentBranchIterations(state);
			for (const iter of itersForFeedback) {
				try {
					const evalPath = path.join(ctx.cwd, resultsDir, `iter_${iter.iteration}`, "eval_results.json");
					if (fs.existsSync(evalPath)) {
						const raw = JSON.parse(fs.readFileSync(evalPath, "utf-8"));
						feedbackData.push({
							iteration: iter.iteration,
							tasks: (raw.tasks || []).map((t: Record<string, unknown>) => ({
								number: t.number as number,
								name: t.name as string,
								tier: t.tier as string,
								completed: t.completed as boolean,
								score: t.score as number,
								persona_feedback: (t.persona_feedback as string) || "",
								stuck_points: (t.stuck_points as string[]) || [],
								wishlist: (t.wishlist as string[]) || [],
								timed_out: t.timed_out as boolean | undefined,
							})),
						});
					}
				} catch { /* skip iterations without eval data */ }
			}
			ctx.ui.setWidget("autoproto", (_tui, theme) =>
				renderFullscreenWidget(state, theme, feedbackData),
			);
		} else if (dashboardMode === "expanded") {
			ctx.ui.setWidget("autoproto", (_tui, theme) =>
				renderExpandedWidget(state, theme),
			);
		} else {
			ctx.ui.setWidget("autoproto", (_tui, theme) =>
				renderCompactWidget(state, theme),
			);
		}
	}

	// -------------------------------------------------------------------
	// Keyboard shortcut — toggle dashboard expand/collapse
	// -------------------------------------------------------------------

	pi.registerShortcut("ctrl+x", {
		description: "Cycle autoproto dashboard: compact → expanded → feedback → compact",
		handler: async (ctx) => {
			if (!runtime.state.active) return;
			const modes = ["compact", "expanded", "fullscreen"] as const;
			const currentIdx = modes.indexOf(dashboardMode);
			dashboardMode = modes[(currentIdx + 1) % modes.length];
			updateWidget(ctx);
		},
	});

	// -------------------------------------------------------------------
	// /autoproto command
	// -------------------------------------------------------------------

	pi.registerCommand("autoproto", {
		description: "Autoproto status and control (start/status/off)",
		handler: async (args, ctx) => {
			const subcommand = args?.trim().toLowerCase();

			if (subcommand === "off") {
				runtime.state.active = false;
				ctx.ui.setWidget("autoproto", undefined);
				ctx.ui.setStatus("autoproto", undefined);
				ctx.ui.notify("Autoproto mode disabled.", "info");
				return;
			}

			if (subcommand === "start") {
				ctx.ui.notify("Use /skill:autoproto to start a new autoproto session, or call init_autoproto.", "info");
				return;
			}

			// Default: show status
			const state = runtime.state;
			if (!state.active) {
				ctx.ui.notify("Autoproto is not active. Use /skill:autoproto or init_autoproto to start.", "info");
				return;
			}

			const iters = currentBranchIterations(state);
			const latest = latestIteration(state);
			const best = bestIteration(state);

			let status = `Autoproto: ${state.experimentName ?? "unnamed"} (${state.mode} mode)\n`;
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

		let extra = "\n\n## Autoproto Mode (ACTIVE)";
		extra += "\nYou are in autoproto mode — iterating on a web app prototype with persona-driven evaluation.";
		extra += "\nUse init_autoproto, run_evaluation, log_iteration, and generate_report tools.";
		extra += "\nRead the autoproto skill (/skill:autoproto) for the full workflow.";

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
			ctx.ui.setStatus("autoproto", undefined);
			return;
		}

		const latest = latestIteration(runtime.state);
		const elapsed = getElapsedMs(runtime.state);
		const timeStr = elapsed > 0 ? ` │ ⏱ ${formatDuration(elapsed)}` : "";
		if (latest) {
			const plateauFlag = isPlateaued(runtime.state) ? " ⚠️" : "";
			ctx.ui.setStatus(
				"autoproto",
				ctx.ui.theme.fg("accent", `🎯 iter ${latest.iteration} │ ${latest.composite.toFixed(1)}${plateauFlag}${timeStr}`),
			);
		} else {
			ctx.ui.setStatus("autoproto", ctx.ui.theme.fg("dim", `🎯 autoproto${timeStr}`));
		}
	});

	// Cleanup on shutdown — kill cached dev server and clear UI
	pi.on("session_shutdown", async (_event, ctx) => {
		if (runtime.devServerCleanup) {
			await runtime.devServerCleanup();
			runtime.devServerPort = null;
			runtime.devServerCleanup = null;
		}
		ctx.ui.setWidget("autoproto", undefined);
		ctx.ui.setStatus("autoproto", undefined);
	});
}
