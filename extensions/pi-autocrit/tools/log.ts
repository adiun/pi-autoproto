/**
 * log_iteration tool — records iteration results and manages history files.
 *
 * Also handles:
 * - Archiving best iteration results (Issue #5)
 * - Per-task score history for stuck detection & variance tracking (Issues #2, #3)
 * - Per-prototype iteration budget warnings (Issue #7)
 * - Git tagging of best iterations
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	appendIteration as persistIteration,
	appendTaskScores,
	type AutocritRuntime,
	type IterationResult,
	type TaskScoreEntry,
	isPlateaued,
	currentBranchIterations,
	bestIteration,
	detectStuckTasks,
	taskScoreStats,
	compositeScoreStats,
} from "../state.js";
import { appendResultsTsv, appendIterationHistory } from "../utils.js";

export function registerLogTool(pi: ExtensionAPI, getRuntime: () => AutocritRuntime) {
	pi.registerTool({
		name: "log_iteration",
		label: "Log Iteration",
		description:
			"Record the result of an evaluation iteration. Updates results.tsv, iteration_history.jsonl, " +
			"and autocrit.jsonl. Reports plateau detection, stuck task warnings, score variance analysis, " +
			"and iteration budget status. Archives best iteration results automatically.",
		promptSnippet: "Record iteration result (scores, description, kept/discarded). Detects plateaus, stuck tasks, and score variance.",
		promptGuidelines: [
			"Always call log_iteration after run_evaluation to record the result.",
			"Set kept=true if the score improved or held steady, kept=false if it dropped.",
			"If kept=false, revert changes with: git checkout -- src/ package.json vite.config.js",
			"Watch for plateau warnings — if flagged, consider stopping the iteration loop.",
			"Watch for stuck task warnings — these tasks may need higher max_steps or be marked as blocked.",
			"Watch for variance warnings — score changes flagged as noise should be weighed against qualitative feedback.",
			"Watch for iteration budget warnings in full mode — move to the next prototype when budget is exhausted.",
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

			const resultsDir = state.resultsDir ?? "results";
			const evalResultsPath = path.join(ctx.cwd, resultsDir, `iter_${params.iteration}`, "eval_results.json");
			let evalResultsData: Record<string, unknown> | null = null;

			if (composite === undefined || p0 === undefined || p1 === undefined || p2 === undefined) {
				try {
					if (fs.existsSync(evalResultsPath)) {
						evalResultsData = JSON.parse(fs.readFileSync(evalResultsPath, "utf-8"));
						composite = composite ?? (evalResultsData!.composite_score as number) ?? 0;
						p0 = p0 ?? (evalResultsData!.p0_score as number) ?? 0;
						p1 = p1 ?? (evalResultsData!.p1_score as number) ?? 0;
						p2 = p2 ?? (evalResultsData!.p2_score as number) ?? 0;
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

			// Read eval_results.json for per-task scores (if not already loaded)
			if (!evalResultsData && fs.existsSync(evalResultsPath)) {
				try {
					evalResultsData = JSON.parse(fs.readFileSync(evalResultsPath, "utf-8"));
				} catch { /* ignore */ }
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

			// Persist iteration to autocrit.jsonl
			persistIteration(ctx.cwd, result);

			// Track per-task scores for stuck detection and variance analysis
			const taskScoreEntries: TaskScoreEntry[] = [];
			if (evalResultsData) {
				const tasks = evalResultsData.tasks as Array<Record<string, unknown>> | undefined;
				if (tasks) {
					for (const t of tasks) {
						const entry: TaskScoreEntry = {
							iteration: params.iteration,
							taskNumber: (t.number as number) ?? 0,
							taskName: (t.name as string) ?? "",
							tier: (t.tier as string) ?? "",
							score: (t.score as number) ?? 0,
							stuckPoints: (t.stuck_points as string[]) ?? [],
							branch: state.currentBranch ?? "main",
						};
						taskScoreEntries.push(entry);
					}
					if (taskScoreEntries.length > 0) {
						appendTaskScores(ctx.cwd, taskScoreEntries);
						state.taskScores.push(...taskScoreEntries);
					}
				}
			}

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

			// ── Archive best iteration results (#5) ──────────────────────────
			const prevBest = bestIteration(state);
			// bestIteration includes the newly-pushed result, so check if this IS the new best
			const isNewBest = params.kept && prevBest && prevBest.iteration === params.iteration;
			if (isNewBest && state.resultsDir) {
				const branchSlug = (state.currentBranch ?? "main").replace(/\//g, "_");
				const bestDir = path.join(ctx.cwd, state.resultsDir, "best", branchSlug);
				try {
					fs.mkdirSync(bestDir, { recursive: true });
					// Copy eval_results.json
					if (fs.existsSync(evalResultsPath)) {
						fs.copyFileSync(evalResultsPath, path.join(bestDir, "eval_results.json"));
					}
					// Copy screenshots if they exist
					const screenshotSrc = path.join(ctx.cwd, resultsDir, `iter_${params.iteration}`, "screenshots");
					const screenshotDst = path.join(bestDir, "screenshots");
					if (fs.existsSync(screenshotSrc)) {
						fs.mkdirSync(screenshotDst, { recursive: true });
						for (const file of fs.readdirSync(screenshotSrc)) {
							fs.copyFileSync(
								path.join(screenshotSrc, file),
								path.join(screenshotDst, file),
							);
						}
					}
				} catch { /* best-effort */ }

				// Git tag the best iteration
				const tagName = `autocrit/${state.experimentName ?? "exp"}/${branchSlug}/best-iter-${params.iteration}-score-${composite!.toFixed(0)}`;
				try {
					await pi.exec("git", ["tag", "-f", tagName]);
				} catch { /* git tag is best-effort */ }
			}

			// Persist state to session
			pi.appendEntry("autocrit-state", { state });

			// ── Build response ───────────────────────────────────────────────
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

			if (isNewBest) {
				response += `\n🏆 New best score for this branch! Results archived.\n`;
			}

			// Suggest revert if discarded
			if (!params.kept) {
				response += "\nChanges should be reverted: git checkout -- src/ package.json vite.config.js\n";
			} else {
				response += "\nCommit the changes: git add -A && git commit -m \"iter " + params.iteration + ": " + params.description + "\"\n";
			}

			// ── Variance analysis (#3) ───────────────────────────────────────
			if (iters.length > 1 && taskScoreEntries.length > 0) {
				const prev = iters[iters.length - 2];
				const varianceNotes: string[] = [];

				for (const entry of taskScoreEntries) {
					const stats = taskScoreStats(state, entry.taskNumber);
					if (!stats || stats.count < 3) continue;

					// Find previous score for this task
					const prevTaskScores = state.taskScores.filter(
						(e) => e.taskNumber === entry.taskNumber
							&& e.branch === entry.branch
							&& e.iteration === prev.iteration,
					);
					if (prevTaskScores.length === 0) continue;
					const prevScore = prevTaskScores[0].score;
					const delta = entry.score - prevScore;

					if (Math.abs(delta) > 0 && Math.abs(delta) <= stats.stdev) {
						varianceNotes.push(
							`Task ${entry.taskNumber} changed ${prevScore}→${entry.score} (Δ${delta >= 0 ? "+" : ""}${delta.toFixed(0)}), but historical range is ${stats.min}–${stats.max} (stdev ${stats.stdev}). This may be noise.`,
						);
					}
				}

				// Composite-level variance check
				const compStats = compositeScoreStats(state);
				if (compStats && iters.length > 1) {
					const compDelta = composite! - prev.composite;
					if (Math.abs(compDelta) > 0 && Math.abs(compDelta) <= compStats.stdev) {
						varianceNotes.push(
							`Composite changed ${prev.composite.toFixed(1)}→${composite!.toFixed(1)} (Δ${compDelta >= 0 ? "+" : ""}${compDelta.toFixed(1)}), but historical composite stdev is ${compStats.stdev}. This is likely noise.`,
						);
					}
				}

				if (varianceNotes.length > 0) {
					response += "\n📊 Variance analysis:\n";
					for (const note of varianceNotes) {
						response += `  • ${note}\n`;
					}
				}
			}

			// ── Stuck task detection (#2) ────────────────────────────────────
			const stuckTasks = detectStuckTasks(state);
			if (stuckTasks.length > 0) {
				response += "\n🚧 Structurally stuck tasks detected:\n";
				for (const st of stuckTasks) {
					const isBlocked = state.blockedTasks.includes(st.taskNumber);
					response += `  ⚠️ Task ${st.taskNumber} [${st.tier}] "${st.taskName}": scored 0 in ${st.consecutiveZeros} consecutive kept iterations with step-limit stuck points.`;
					if (isBlocked) {
						response += " (already marked as blocked — excluded from composite)\n";
					} else {
						response += "\n     Consider: (a) adding max_steps to this task in persona.md, (b) marking as blocked, (c) testing with task parameter.\n";
					}
				}
			}

			// ── Iteration budget warning (#7) ────────────────────────────────
			if (state.mode === "full") {
				const cap = state.maxIterationsPerPrototype;
				const branchIters = iters.length;
				const pct = branchIters / cap;
				if (pct >= 1.0) {
					response += `\n⚠️ ITERATION BUDGET EXHAUSTED: ${branchIters}/${cap} iterations on ${state.currentBranch ?? "this branch"}. Switch to the next prototype.\n`;
				} else if (pct >= 0.6) {
					const remaining = cap - branchIters;
					response += `\n📋 Iteration budget: ${branchIters}/${cap} used on ${state.currentBranch ?? "this branch"}. ${remaining} remaining.\n`;
				}
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

			// Blocked tasks summary
			if (state.blockedTasks.length > 0) {
				response += `\nBlocked tasks (excluded from composite): ${state.blockedTasks.join(", ")}`;
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
