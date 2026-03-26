/**
 * log_iteration tool — records iteration results and manages history files.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { appendIteration as persistIteration, type AutocritRuntime, type IterationResult, isPlateaued, currentBranchIterations } from "../state.js";
import { appendResultsTsv, appendIterationHistory } from "../utils.js";

export function registerLogTool(pi: ExtensionAPI, getRuntime: () => AutocritRuntime) {
	pi.registerTool({
		name: "log_iteration",
		label: "Log Iteration",
		description:
			"Record the result of an evaluation iteration. Updates results.tsv, iteration_history.jsonl, " +
			"and autocrit.jsonl. Reports plateau detection and stopping conditions.",
		promptSnippet: "Record iteration result (scores, description, kept/discarded). Detects plateaus.",
		promptGuidelines: [
			"Always call log_iteration after run_evaluation to record the result.",
			"Set kept=true if the score improved or held steady, kept=false if it dropped.",
			"If kept=false, revert changes with: git checkout -- src/ package.json vite.config.js",
			"Watch for plateau warnings — if flagged, consider stopping the iteration loop.",
		],
		parameters: Type.Object({
			iteration: Type.Number({ description: "Iteration number" }),
			composite: Type.Number({ description: "Composite score from evaluation" }),
			p0: Type.Number({ description: "P0 tier score" }),
			p1: Type.Number({ description: "P1 tier score" }),
			p2: Type.Number({ description: "P2 tier score" }),
			description: Type.String({ description: "Short description of what this iteration changed" }),
			kept: Type.Boolean({ description: "Whether the change was kept (score improved/held) or discarded (score dropped)" }),
			dev_plan: Type.Optional(
				Type.Object({
					target_task: Type.Optional(Type.Number()),
					thesis: Type.Optional(Type.String()),
					approach: Type.Optional(Type.String()),
				}, { description: "Development plan for this iteration" }),
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runtime = getRuntime();
			const state = runtime.state;

			if (!state.active) {
				return {
					content: [{ type: "text", text: "❌ Autocrit not initialized. Call init_autocrit first." }],
					details: {},
				};
			}

			const result: IterationResult = {
				iteration: params.iteration,
				composite: params.composite,
				p0: params.p0,
				p1: params.p1,
				p2: params.p2,
				description: params.description,
				kept: params.kept,
				branch: state.currentBranch ?? "main",
				timestamp: Date.now(),
			};

			// Persist to autocrit.jsonl
			persistIteration(ctx.cwd, result);

			// Update in-memory state
			state.iterations.push(result);

			// Persist to results files
			if (state.resultsDir) {
				const absResultsDir = path.join(ctx.cwd, state.resultsDir);
				if (fs.existsSync(absResultsDir)) {
					appendResultsTsv(absResultsDir, params);

					const historyEntry: Record<string, unknown> = {
						iteration: params.iteration,
						timestamp: new Date().toISOString(),
						composite: params.composite,
						p0: params.p0,
						p1: params.p1,
						p2: params.p2,
						description: params.description,
						kept: params.kept,
					};
					if (params.dev_plan) {
						historyEntry.dev_plan = params.dev_plan;
					}
					appendIterationHistory(absResultsDir, historyEntry);
				}
			}

			// Persist state to session
			pi.appendEntry("autocrit-state", { state });

			// Build response
			const iters = currentBranchIterations(state);
			const keptIters = iters.filter((r) => r.kept);
			const statusEmoji = params.kept ? "✅" : "⚠️";
			const statusWord = params.kept ? "kept" : "discarded";

			let response = `${statusEmoji} Iteration ${params.iteration}: ${params.description} — ${statusWord}\n`;
			response += `Composite: ${params.composite.toFixed(1)} | P0: ${params.p0.toFixed(1)} | P1: ${params.p1.toFixed(1)} | P2: ${params.p2.toFixed(1)}\n`;

			// Delta from previous
			if (iters.length > 1) {
				const prev = iters[iters.length - 2];
				const delta = params.composite - prev.composite;
				const sign = delta >= 0 ? "+" : "";
				response += `Change: ${sign}${delta.toFixed(1)} from iteration ${prev.iteration}\n`;
			}

			// Suggest revert if discarded
			if (!params.kept) {
				response += "\nChanges should be reverted: git checkout -- src/ package.json vite.config.js\n";
			} else {
				response += "\nCommit the changes: git add -A && git commit -m \"iter " + params.iteration + ": " + params.description + "\"\n";
			}

			// Plateau detection
			if (isPlateaued(state)) {
				response += "\n⚠️ PLATEAU DETECTED: Composite hasn't improved by >3 points in the last 3 kept iterations.\n";
				response += "Consider stopping the iteration loop and running final multi-variant evaluation.\n";
			}

			// Stopping conditions
			const allP0Pass = params.p0 >= 100 && params.composite > 85;
			if (allP0Pass) {
				response += "\n🎉 All P0 tasks passing with composite > 85. Consider stopping.\n";
			}
			if (iters.length >= 10) {
				response += "\n⏰ 10 iterations completed. Consider stopping.\n";
			}

			response += `\nTotal iterations: ${iters.length} (${keptIters.length} kept)`;

			return {
				content: [{ type: "text", text: response }],
				details: { result, plateaued: isPlateaued(state) },
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("log_iteration "));
			text += theme.fg("accent", `iter ${args.iteration ?? "?"}`);
			const kd = args.kept ? theme.fg("success", " kept") : theme.fg("warning", " discarded");
			text += kd;
			if (args.composite !== undefined) {
				text += theme.fg("dim", ` (${args.composite})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const t = result.content[0];
			return new Text(t?.type === "text" ? t.text : "", 0, 0);
		},
	});
}
