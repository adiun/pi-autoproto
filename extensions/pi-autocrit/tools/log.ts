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
			composite: Type.Optional(Type.Number({ description: "Composite score from evaluation. If omitted, auto-read from eval_results.json." })),
			p0: Type.Optional(Type.Number({ description: "P0 tier score. If omitted, auto-read from eval_results.json." })),
			p1: Type.Optional(Type.Number({ description: "P1 tier score. If omitted, auto-read from eval_results.json." })),
			p2: Type.Optional(Type.Number({ description: "P2 tier score. If omitted, auto-read from eval_results.json." })),
			description: Type.String({ description: "Short description of what this iteration changed" }),
			kept: Type.Boolean({ description: "Whether the change was kept (score improved/held) or discarded (score dropped)" }),
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

			// Auto-read scores from eval_results.json if not provided
			let composite = params.composite;
			let p0 = params.p0;
			let p1 = params.p1;
			let p2 = params.p2;

			if (composite === undefined || p0 === undefined || p1 === undefined || p2 === undefined) {
				const resultsDir = state.resultsDir ?? "results";
				const evalResultsPath = path.join(ctx.cwd, resultsDir, `iter_${params.iteration}`, "eval_results.json");
				try {
					if (fs.existsSync(evalResultsPath)) {
						const evalResults = JSON.parse(fs.readFileSync(evalResultsPath, "utf-8"));
						composite = composite ?? evalResults.composite_score ?? 0;
						p0 = p0 ?? evalResults.p0_score ?? 0;
						p1 = p1 ?? evalResults.p1_score ?? 0;
						p2 = p2 ?? evalResults.p2_score ?? 0;
					} else {
						return {
							content: [{ type: "text", text: `❌ Scores not provided and eval_results.json not found at ${evalResultsPath}.\nEither provide composite/p0/p1/p2 scores or run run_evaluation first.` }],
							details: {},
						};
					}
				} catch {
					return {
						content: [{ type: "text", text: `❌ Could not read eval_results.json at ${evalResultsPath}.` }],
						details: {},
					};
				}
			}

			const result: IterationResult = {
				iteration: params.iteration,
				composite: composite!,
				p0: p0!,
				p1: p1!,
				p2: p2!,
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
					appendResultsTsv(absResultsDir, { ...params, composite: composite!, p0: p0!, p1: p1!, p2: p2! });

					const historyEntry: Record<string, unknown> = {
						iteration: params.iteration,
						timestamp: new Date().toISOString(),
						composite: composite!,
						p0: p0!,
						p1: p1!,
						p2: p2!,
						description: params.description,
						kept: params.kept,
					};
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
			response += `Composite: ${composite!.toFixed(1)} | P0: ${p0!.toFixed(1)} | P1: ${p1!.toFixed(1)} | P2: ${p2!.toFixed(1)}\n`;

			// Delta from previous
			if (iters.length > 1) {
				const prev = iters[iters.length - 2];
				const delta = composite! - prev.composite;
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
			const allP0Pass = p0! >= 100 && composite! > 85;
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
