/**
 * run_evaluation tool — wraps evaluate.py to run persona-driven evaluation.
 *
 * Key design decisions:
 * - Runs tasks individually with per-task timeouts and auto-retries
 * - Uses all-at-once execution only for variants mode
 * - Merges per-task results into a combined eval_results.json
 * - Distinguishes infrastructure timeouts from UX failures
 * - Caches dev server across evaluations for performance
 * - Reports partial results even if some tasks fail/timeout
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateTail, formatSize } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AutocritRuntime } from "../state.js";
import { buildEvaluateCommand, getPythonDir, parsePersonaTaskNumbers, formatDuration, getElapsedMs } from "../utils.js";
import {
	readEvalResults, mergeTaskResult, recomputeScores, computeTaskTimeoutMs,
	DEFAULT_MAX_STEPS, QUICK_MAX_STEPS, MAX_TASK_TIMEOUT_MS, TIMEOUT_PER_STEP_MS, TASK_OVERHEAD_MS,
	type TaskResultJson, type EvalResultsJson,
} from "../evaluate-logic.js";

// Truncation limits for LLM context
const EVAL_MAX_LINES = 60;
const EVAL_MAX_BYTES = 8 * 1024; // 8KB

// Base timeout for all-at-once modes (server startup, etc.)
const TIMEOUT_BASE_MS = 60_000;

export function registerEvaluateTool(pi: ExtensionAPI, getRuntime: () => AutocritRuntime) {
	pi.registerTool({
		name: "run_evaluation",
		label: "Run Evaluation",
		description:
			"Run persona-driven evaluation of the current web app. Wraps evaluate.py: " +
			"starts the dev server if needed, runs agent-browser with the persona agent, " +
			"and returns structured results (scores, per-task feedback, stuck points, wishlist). " +
			"When running all tasks, executes them individually with per-task timeouts and auto-retries. " +
			"Output is truncated for context efficiency — read eval_results.json for full details.",
		promptSnippet: "Run persona evaluation (quick, full, or variants mode). Returns structured scores and feedback.",
		promptGuidelines: [
			"Use run_evaluation instead of manually running evaluate.py — it handles paths, flags, and output parsing.",
			"After run_evaluation, always call log_iteration to record the result.",
			"Use mode 'quick' for baseline and fast iterations (1 run, no feedback), 'full' for thorough evaluation (2 runs, with feedback).",
			"Use mode 'variants' with variant_count for final multi-persona evaluation.",
			"Run ONE evaluation per iteration. Do not re-run to confirm — trust the score.",
			"Only use the task filter when debugging a specific stuck task after a full evaluation identified it.",
			"Read eval_results.json in the output directory for full per-task details including persona_feedback and wishlist.",
		],
		parameters: Type.Object({
			iteration: Type.Number({
				description: "Iteration number (0 for baseline)",
			}),
			mode: Type.Optional(
				StringEnum(["quick", "full", "variants"] as const, {
					description: "Evaluation mode: quick (1 run, no feedback), full (2 runs, with feedback), variants (multi-persona). Default: full",
				}),
			),
			task: Type.Optional(
				Type.Number({ description: "Run only this task number (for debugging a specific stuck task after a full evaluation)" }),
			),
			variant_count: Type.Optional(
				Type.Number({ description: "Number of persona variants for variants mode (default: 4)" }),
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
			const evalResultsPath = path.join(ctx.cwd, iterDir, "eval_results.json");
			const mode = params.mode ?? "full";

			// Variants mode runs all-at-once (evaluate.py handles variant generation internally)
			// Everything else uses per-task execution with server reuse and caching
			if (mode === "variants") {
				return await runAllAtOnce(params, {
					pythonDir, useUv, iterDir, screenshotDir,
					evalResultsPath, mode, signal, onUpdate, ctx,
				});
			} else {
				return await runPerTask(params, {
					pythonDir, useUv, iterDir, screenshotDir,
					evalResultsPath, mode, signal, onUpdate, ctx,
				});
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("run_evaluation "));
			text += theme.fg("accent", `iter ${args.iteration ?? "?"}`);
			if (args.mode) text += theme.fg("dim", ` (${args.mode})`);
			if (args.task) text += theme.fg("dim", ` task ${args.task}`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const t = result.content[0];
			const text = t?.type === "text" ? t.text : "";
			const lines = text.split("\n");
			if (lines.length <= 12) return new Text(text, 0, 0);
			return new Text(lines.slice(0, 12).join("\n") + theme.fg("dim", `\n… ${lines.length - 12} more lines`), 0, 0);
		},
	});

	// ── Helper types ────────────────────────────────────────────────────

	interface RunContext {
		pythonDir: string;
		useUv: boolean;
		iterDir: string;
		screenshotDir: string;
		evalResultsPath: string;
		mode: string;
		signal?: AbortSignal;
		onUpdate?: (update: { content: Array<{ type: string; text: string }> }) => void;
		ctx: { cwd: string };
	}

	/**
	 * Start a Vite dev server for the project. Returns the port it's running on.
	 * The server is started via a background shell process and we poll until ready.
	 */
	async function startDevServer(cwd: string): Promise<{ port: number; cleanup: () => Promise<void> }> {
		// Find a free port
		const port = await findFreePort();

		const usePnpm = fs.existsSync(path.join(cwd, "pnpm-lock.yaml"));
		const runner = usePnpm ? "pnpm exec" : "npx";
		// Start server in background via nohup so it survives parent process changes.
		const startCmd = `nohup ${runner} vp dev --port ${port} --strictPort --host localhost > /dev/null 2>&1 &`;

		await pi.exec("bash", ["-c", startCmd], { timeout: 5000 });

		// Poll until server is ready (max 20s)
		const deadline = Date.now() + 20_000;
		let ready = false;
		while (Date.now() < deadline) {
			try {
				const check = await pi.exec("bash", ["-c", `curl -s -o /dev/null -w "%{http_code}" http://localhost:${port}`], { timeout: 3000 });
				if (check.stdout?.trim() === "200") {
					ready = true;
					break;
				}
			} catch {
				// not ready yet
			}
			await new Promise((resolve) => setTimeout(resolve, 500));
		}

		if (!ready) {
			// Kill any processes on the port
			await pi.exec("bash", ["-c", `lsof -ti:${port} | xargs kill 2>/dev/null`], { timeout: 5000 });
			throw new Error(`Dev server failed to start on port ${port} within 20s`);
		}

		const cleanup = async () => {
			// Kill all processes listening on the port (Vite + node children)
			await pi.exec("bash", ["-c", `lsof -ti:${port} | xargs kill 2>/dev/null`], { timeout: 5000 });
			// Wait a moment for cleanup
			await new Promise((resolve) => setTimeout(resolve, 500));
		};

		return { port, cleanup };
	}

	async function findFreePort(): Promise<number> {
		const result = await pi.exec("bash", ["-c",
			`python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()"`,
		], { timeout: 5000 });
		const port = parseInt(result.stdout?.trim() ?? "", 10);
		if (isNaN(port)) throw new Error("Could not find free port");
		return port;
	}

	/**
	 * Get cached dev server or start a new one.
	 * Server is cached in runtime for reuse across run_evaluation calls.
	 * Vite's HMR handles code changes automatically — no need to restart.
	 */
	async function getOrCreateDevServer(cwd: string): Promise<{ port: number; cleanup: () => Promise<void> }> {
		const runtime = getRuntime();

		// Check if we have a cached server that's still alive
		if (runtime.devServerPort !== null && runtime.devServerCleanup !== null) {
			try {
				const check = await pi.exec("bash", ["-c",
					`curl -s -o /dev/null -w "%{http_code}" http://localhost:${runtime.devServerPort}`,
				], { timeout: 3000 });
				if (check.stdout?.trim() === "200") {
					return {
						port: runtime.devServerPort,
						cleanup: runtime.devServerCleanup,
					};
				}
			} catch {
				// Server died
			}
			// Cached server is dead, clear cache
			runtime.devServerPort = null;
			runtime.devServerCleanup = null;
		}

		// Start new server and cache it
		const server = await startDevServer(cwd);
		runtime.devServerPort = server.port;
		runtime.devServerCleanup = server.cleanup;
		return server;
	}

	// ── Per-task execution ──────────────────────────────────────────────
	// Runs each task as a separate evaluate.py invocation with its own timeout.
	// Merges results incrementally and auto-retries timeouts.
	// Used for quick and full modes (with or without task filter).

	async function runPerTask(
		params: Record<string, unknown>,
		runCtx: RunContext,
	) {
		const state = getRuntime().state;

		// If task filter specified, run only that task; otherwise parse all from persona.md
		const taskNumbers = params.task
			? [params.task as number]
			: parsePersonaTaskNumbers(runCtx.ctx.cwd);

		if (taskNumbers.length === 0) {
			return {
				content: [{ type: "text", text: "❌ No tasks found in persona.md. Check the file format." }],
				details: {},
			};
		}

		// Delete stale eval_results.json before starting
		if (fs.existsSync(runCtx.evalResultsPath)) {
			fs.unlinkSync(runCtx.evalResultsPath);
		}

		// Initialize combined results
		const combined: EvalResultsJson = {
			composite_score: 0,
			p0_score: 0,
			p1_score: 0,
			p2_score: 0,
			tasks: [],
		};

		const totalTasks = taskNumbers.length;
		let completedCount = 0;
		let timedOutCount = 0;

		// Derive max_steps and runs from mode (no per-call overrides)
		const maxSteps = runCtx.mode === "quick" ? QUICK_MAX_STEPS : DEFAULT_MAX_STEPS;
		const runsForTask = runCtx.mode === "quick" ? 1 : 2;
		const taskTimeoutMs = computeTaskTimeoutMs(maxSteps, runsForTask);

		// Get or create cached dev server
		runCtx.onUpdate?.({
			content: [{
				type: "text",
				text: `Starting dev server…`,
			}],
		});
		const devServer = await getOrCreateDevServer(runCtx.ctx.cwd);

		for (const taskNum of taskNumbers) {
			if (runCtx.signal?.aborted) break;

			completedCount++;
			runCtx.onUpdate?.({
				content: [{
					type: "text",
					text: `Evaluating task ${taskNum} (${completedCount}/${totalTasks})…`,
				}],
			});

			// Temp output dir for this task's results
			const taskOutputDir = path.join(runCtx.iterDir, `_task_${taskNum}`);
			fs.mkdirSync(path.join(runCtx.ctx.cwd, taskOutputDir), { recursive: true });

			const command = buildEvaluateCommand({
				pythonDir: runCtx.pythonDir,
				useUv: runCtx.useUv,
				iteration: params.iteration as number,
				mode: runCtx.mode,
				task: taskNum,
				outputDir: taskOutputDir,
				screenshotDir: runCtx.screenshotDir,
				personaCmd: state.personaCmd!,
				port: devServer.port,
			});

			let result = await pi.exec("bash", ["-c", command], {
				signal: runCtx.signal,
				timeout: taskTimeoutMs,
			});

			// Check if it timed out (exit code from timeout kill is typically non-zero with no output)
			const taskResultPath = path.join(runCtx.ctx.cwd, taskOutputDir, "eval_results.json");
			let taskResult = readEvalResults(taskResultPath);
			const didTimeout = result.code !== 0 && !taskResult;

			// Auto-retry once on timeout
			if (didTimeout && !runCtx.signal?.aborted) {
				runCtx.onUpdate?.({
					content: [{
						type: "text",
						text: `Task ${taskNum} timed out, retrying (${completedCount}/${totalTasks})…`,
					}],
				});

				result = await pi.exec("bash", ["-c", command], {
					signal: runCtx.signal,
					timeout: taskTimeoutMs,
				});
				taskResult = readEvalResults(taskResultPath);
			}

			if (taskResult) {
				// Mark timeout if the result came from retry
				if (didTimeout && taskResult.tasks.length > 0) {
					taskResult.tasks[0].timed_out = false; // retry succeeded
				}
				mergeTaskResult(combined, taskResult);
			} else {
				// Total failure — record a zero-score placeholder
				timedOutCount++;
				const placeholder: TaskResultJson = {
					number: taskNum,
					name: `Task ${taskNum}`,
					tier: "P0",
					completed: false,
					score: 0,
					steps: 0,
					stuck_points: [didTimeout ? "Infrastructure timeout (not a UX failure)" : "Evaluation error"],
					found_answer: null,
					notes: didTimeout ? "Task timed out — LLM or agent-browser was unresponsive" : "evaluate.py returned an error",
					persona_feedback: "",
					wishlist: [],
					timed_out: didTimeout,
				};
				// Try to get the actual tier/name from existing combined results or leave as placeholder
				const existingTask = combined.tasks.find((t) => t.number === taskNum);
				if (existingTask) {
					placeholder.name = existingTask.name;
					placeholder.tier = existingTask.tier;
				}
				mergeTaskResult(combined, { ...combined, tasks: [placeholder] });
			}

			// Clean up per-task temp dir
			try {
				fs.rmSync(path.join(runCtx.ctx.cwd, taskOutputDir), { recursive: true });
			} catch {
				// ignore
			}

			// Write intermediate combined results after each task
			recomputeScores(combined);
			fs.writeFileSync(runCtx.evalResultsPath, JSON.stringify(combined, null, 2));

			// Stream progress with per-task score
			const lastTask = combined.tasks.find((t) => t.number === taskNum);
			if (lastTask) {
				const status = lastTask.timed_out ? "TIMEOUT" : lastTask.completed ? "PASS" : "FAIL";
				runCtx.onUpdate?.({
					content: [{
						type: "text",
						text: `Task ${taskNum} [${lastTask.tier}]: ${status} (${lastTask.score}) — ${completedCount}/${totalTasks} done | Running composite: ${combined.composite_score}`,
					}],
				});
			}
		}

		// Note: dev server is NOT cleaned up here — it's cached in runtime for reuse

		// Final score recompute
		recomputeScores(combined);
		fs.writeFileSync(runCtx.evalResultsPath, JSON.stringify(combined, null, 2));

		// Build response
		return buildResponse(combined, runCtx.evalResultsPath, timedOutCount);
	}

	// ── All-at-once execution (variants mode only) ──────────────────────
	// evaluate.py handles variant generation and convergence analysis internally.

	async function runAllAtOnce(
		params: Record<string, unknown>,
		runCtx: RunContext,
	) {
		const state = getRuntime().state;

		// Delete stale eval_results.json before starting
		if (fs.existsSync(runCtx.evalResultsPath)) {
			fs.unlinkSync(runCtx.evalResultsPath);
		}

		const command = buildEvaluateCommand({
			pythonDir: runCtx.pythonDir,
			useUv: runCtx.useUv,
			iteration: params.iteration as number,
			mode: runCtx.mode,
			variantCount: (params.variant_count as number | undefined) ?? 4,
			outputDir: runCtx.iterDir,
			screenshotDir: runCtx.screenshotDir,
			personaCmd: state.personaCmd!,
		});

		// Estimate timeout: tasks × per-task timeout × variant count
		const taskNumbers = parsePersonaTaskNumbers(runCtx.ctx.cwd);
		const numTasks = taskNumbers.length || 7;
		const variantCount = (params.variant_count as number) || 4;
		const timeoutMs = TIMEOUT_BASE_MS + (numTasks * computeTaskTimeoutMs(DEFAULT_MAX_STEPS, variantCount));

		runCtx.onUpdate?.({
			content: [{
				type: "text",
				text: `Running evaluation (iteration ${params.iteration}, mode: ${runCtx.mode}, timeout: ${Math.round(timeoutMs / 60_000)}min)…`,
			}],
		});

		const result = await pi.exec("bash", ["-c", command], {
			signal: runCtx.signal,
			timeout: timeoutMs,
		});

		const evalResults = readEvalResults(runCtx.evalResultsPath);

		if (evalResults) {
			return buildResponse(evalResults, runCtx.evalResultsPath, 0);
		}

		// Fallback: no structured results, return raw output
		const combined = (result.stdout ?? "") + (result.stderr ?? "");
		const truncation = truncateTail(combined, {
			maxLines: EVAL_MAX_LINES,
			maxBytes: EVAL_MAX_BYTES,
		});

		const isError = result.code !== 0;
		let responseText = isError ? "❌ Evaluation failed\n\n" : "✅ Evaluation complete\n\n";
		responseText += truncation.content;

		if (truncation.truncated) {
			responseText += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines ` +
				`(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
		}

		return {
			content: [{ type: "text", text: responseText }],
			details: { exitCode: result.code, evalResults: null, outputDir: runCtx.iterDir },
		};
	}

	// ── Response builder ────────────────────────────────────────────────

	function buildResponse(
		evalResults: EvalResultsJson,
		evalResultsPath: string,
		timedOutCount: number,
	) {
		const scores = {
			composite: evalResults.composite_score,
			p0: evalResults.p0_score,
			p1: evalResults.p1_score,
			p2: evalResults.p2_score,
		};

		let responseText = "✅ Evaluation complete\n\n";
		responseText += `Composite: ${scores.composite} | P0: ${scores.p0} | P1: ${scores.p1} | P2: ${scores.p2}\n`;
		if (timedOutCount > 0) {
			responseText += `⚠️ ${timedOutCount} task(s) timed out (infrastructure issue, not UX failure)\n`;
		}
		responseText += "\n";

		for (const task of evalResults.tasks) {
			const status = task.timed_out ? "TIMEOUT" : task.completed ? "PASS" : "FAIL";
			responseText += `Task ${task.number} [${task.tier}] "${task.name}": ${status} (score: ${task.score})\n`;
			if (task.persona_feedback) {
				responseText += `  Feedback: ${task.persona_feedback}\n`;
			}
			const wishlist = task.wishlist;
			if (wishlist && wishlist.length > 0) {
				for (const wish of wishlist) {
					responseText += `  Wish: ${wish}\n`;
				}
			}
			const stuckPoints = task.stuck_points;
			if (stuckPoints && stuckPoints.length > 0) {
				responseText += `  Stuck: ${stuckPoints.join("; ")}\n`;
			}
		}

		responseText += `\nFull results: ${evalResultsPath}`;

		// Show session elapsed time
		const elapsed = getElapsedMs(getRuntime().state);
		if (elapsed > 0) {
			responseText += `\n⏱ Session elapsed: ${formatDuration(elapsed)}`;
		}

		return {
			content: [{ type: "text", text: responseText }],
			details: {
				exitCode: 0,
				evalResults,
				outputDir: path.dirname(evalResultsPath),
			},
		};
	}
}
