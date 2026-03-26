/**
 * run_evaluation tool — wraps evaluate.py to run persona-driven evaluation.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateTail, formatSize } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AutocritRuntime } from "../state.js";
import { buildEvaluateCommand, getPythonDir } from "../utils.js";

// Truncation limits for LLM context
const EVAL_MAX_LINES = 60;
const EVAL_MAX_BYTES = 8 * 1024; // 8KB

export function registerEvaluateTool(pi: ExtensionAPI, getRuntime: () => AutocritRuntime) {
	pi.registerTool({
		name: "run_evaluation",
		label: "Run Evaluation",
		description:
			"Run persona-driven evaluation of the current web app. Wraps evaluate.py: " +
			"starts the dev server if needed, runs agent-browser with the persona agent, " +
			"and returns structured results (scores, per-task feedback, stuck points, wishlist). " +
			"Output is truncated for context efficiency — read eval_results.json for full details.",
		promptSnippet: "Run persona evaluation (calibrate, quick, full, or variants mode). Returns structured scores and feedback.",
		promptGuidelines: [
			"Use run_evaluation instead of manually running evaluate.py — it handles paths, flags, and output parsing.",
			"After run_evaluation, always call log_iteration to record the result.",
			"Use mode 'calibrate' for the baseline run, 'quick' for fast iterations, 'full' for thorough evaluation.",
			"Use mode 'variants' with variant_count for final multi-persona evaluation.",
			"Read eval_results.json in the output directory for full per-task details including persona_feedback and wishlist.",
		],
		parameters: Type.Object({
			iteration: Type.Number({
				description: "Iteration number (0 for baseline/calibration)",
			}),
			mode: Type.Optional(
				StringEnum(["calibrate", "quick", "full", "variants"] as const, {
					description: "Evaluation mode: calibrate (3 runs, stability check), quick (1 run, no feedback), full (2 runs), variants (multi-persona). Default: full",
				}),
			),
			task: Type.Optional(
				Type.Number({ description: "Run only this task number" }),
			),
			tier: Type.Optional(
				StringEnum(["P0", "P1", "P2"] as const, {
					description: "Run only tasks of this tier",
				}),
			),
			variant_count: Type.Optional(
				Type.Number({ description: "Number of persona variants for variants mode (default: 4)" }),
			),
			max_steps: Type.Optional(
				Type.Number({ description: "Max interaction steps per task (default: 15)" }),
			),
			skip_feedback: Type.Optional(
				Type.Boolean({ description: "Skip persona feedback generation (saves 1 LLM call per task)" }),
			),
			requirements_file: Type.Optional(
				Type.String({ description: "Path to separate requirements.md (if tasks are not in persona.md)" }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const runtime = getRuntime();
			const state = runtime.state;

			if (!state.active || !state.personaCmd) {
				return {
					content: [{
						type: "text",
						text: "❌ Autocrit not initialized. Call init_autocrit first.",
					}],
					details: {},
				};
			}

			// Resolve output directories
			const resultsDir = state.resultsDir ?? "results";
			const iterDir = path.join(resultsDir, `iter_${params.iteration}`);
			const screenshotDir = path.join(iterDir, "screenshots");
			fs.mkdirSync(path.join(ctx.cwd, iterDir), { recursive: true });
			fs.mkdirSync(path.join(ctx.cwd, screenshotDir), { recursive: true });

			// Check for uv
			let useUv = true;
			try {
				const uvCheck = await pi.exec("which", ["uv"]);
				useUv = uvCheck.code === 0;
			} catch {
				useUv = false;
			}

			const pythonDir = getPythonDir();

			// Build command
			const command = buildEvaluateCommand({
				pythonDir,
				useUv,
				iteration: params.iteration,
				mode: params.mode,
				task: params.task,
				tier: params.tier,
				variantCount: params.variant_count ?? 4,
				maxSteps: params.max_steps,
				skipFeedback: params.skip_feedback,
				requirementsFile: params.requirements_file,
				outputDir: iterDir,
				screenshotDir,
				personaCmd: state.personaCmd,
			});

			// Run evaluation
			onUpdate?.({
				content: [{ type: "text", text: `Running evaluation (iteration ${params.iteration}, mode: ${params.mode ?? "full"})…` }],
			});

			const result = await pi.exec("bash", ["-c", command], {
				signal,
				timeout: 600,
			});

			// Parse eval_results.json if it exists
			const evalResultsPath = path.join(ctx.cwd, iterDir, "eval_results.json");
			let evalResults: Record<string, unknown> | null = null;
			try {
				if (fs.existsSync(evalResultsPath)) {
					evalResults = JSON.parse(fs.readFileSync(evalResultsPath, "utf-8"));
				}
			} catch {
				// couldn't parse, will return raw output
			}

			// Build response
			const isError = result.code !== 0;
			let responseText: string;

			if (evalResults) {
				// Structured response with parsed results
				const scores = {
					composite: evalResults.composite_score,
					p0: evalResults.p0_score,
					p1: evalResults.p1_score,
					p2: evalResults.p2_score,
				};

				responseText = `${isError ? "⚠️ Evaluation completed with errors" : "✅ Evaluation complete"}\n\n`;
				responseText += `Composite: ${scores.composite} | P0: ${scores.p0} | P1: ${scores.p1} | P2: ${scores.p2}\n\n`;

				// Per-task summary
				const tasks = (evalResults.tasks as Array<Record<string, unknown>>) ?? [];
				for (const task of tasks) {
					const status = task.completed ? "PASS" : "FAIL";
					responseText += `Task ${task.number} [${task.tier}] "${task.name}": ${status} (score: ${task.score})\n`;
					if (task.persona_feedback) {
						responseText += `  Feedback: ${task.persona_feedback}\n`;
					}
					const wishlist = task.wishlist as string[] | undefined;
					if (wishlist && wishlist.length > 0) {
						for (const wish of wishlist) {
							responseText += `  Wish: ${wish}\n`;
						}
					}
					const stuckPoints = task.stuck_points as string[] | undefined;
					if (stuckPoints && stuckPoints.length > 0) {
						responseText += `  Stuck: ${stuckPoints.join("; ")}\n`;
					}
				}

				responseText += `\nFull results: ${evalResultsPath}`;
			} else {
				// Fallback: truncated raw output
				const combined = (result.stdout ?? "") + (result.stderr ?? "");
				const truncation = truncateTail(combined, {
					maxLines: EVAL_MAX_LINES,
					maxBytes: EVAL_MAX_BYTES,
				});

				responseText = isError ? "❌ Evaluation failed\n\n" : "✅ Evaluation complete\n\n";
				responseText += truncation.content;

				if (truncation.truncated) {
					responseText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines ` +
						`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
				}
			}

			return {
				content: [{ type: "text", text: responseText }],
				details: {
					exitCode: result.code,
					evalResults,
					outputDir: iterDir,
				},
				...(isError && !evalResults ? {} : {}),
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("run_evaluation "));
			text += theme.fg("accent", `iter ${args.iteration ?? "?"}`);
			if (args.mode) text += theme.fg("dim", ` (${args.mode})`);
			if (args.task) text += theme.fg("dim", ` task ${args.task}`);
			if (args.tier) text += theme.fg("dim", ` ${args.tier}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const t = result.content[0];
			const text = t?.type === "text" ? t.text : "";
			// Show first 10 lines in collapsed, full in expanded
			const lines = text.split("\n");
			if (lines.length <= 12) return new Text(text, 0, 0);
			return new Text(lines.slice(0, 12).join("\n") + theme.fg("dim", `\n… ${lines.length - 12} more lines`), 0, 0);
		},
	});
}
