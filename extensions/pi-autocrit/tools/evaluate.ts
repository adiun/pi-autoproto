/**
 * run_evaluation tool — wraps evaluate.py to run persona-driven evaluation.
 *
 * Key design decisions:
 * - Runs tasks individually when no specific task is requested, with per-task timeouts
 * - Merges per-task results into a combined eval_results.json
 * - Distinguishes infrastructure timeouts from UX failures
 * - Auto-retries tasks that time out (once)
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
import { buildEvaluateCommand, getPythonDir, parsePersonaTaskNumbers } from "../utils.js";

// Truncation limits for LLM context
const EVAL_MAX_LINES = 60;
const EVAL_MAX_BYTES = 8 * 1024; // 8KB

// Default max steps per task (must match evaluate.py DEFAULT_MAX_STEPS)
const DEFAULT_MAX_STEPS = 15;

// Timeout per step: ~60s covers LLM call (~30-50s) + screenshot + browser action + wait
const TIMEOUT_PER_STEP_MS = 60_000;

// Scoring/feedback overhead per task (LLM scoring call + optional feedback call)
const TASK_OVERHEAD_MS = 60_000;

// Hard cap to avoid infinite waits on a single task
const MAX_TASK_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

// Base timeout for all-at-once modes (server startup, etc.)
const TIMEOUT_BASE_MS = 60_000;

interface TaskResultJson {
	number: number;
	name: string;
	tier: string;
	completed: boolean;
	score: number;
	steps: number;
	stuck_points: string[];
	found_answer: string | null;
	notes: string;
	persona_feedback: string;
	wishlist: string[];
	timed_out?: boolean;
}

interface EvalResultsJson {
	composite_score: number;
	p0_score: number;
	p1_score: number;
	p2_score: number;
	tasks: TaskResultJson[];
	[key: string]: unknown;
}

function readEvalResults(filePath: string): EvalResultsJson | null {
	try {
		if (fs.existsSync(filePath)) {
			return JSON.parse(fs.readFileSync(filePath, "utf-8"));
		}
	} catch {
		// corrupted file
	}
	return null;
}

/**
 * Merge a single-task eval_results.json into an existing combined result.
 * Updates the task entry if it exists, appends if new.
 */
function mergeTaskResult(
	combined: EvalResultsJson,
	singleTaskResult: EvalResultsJson,
): void {
	for (const newTask of singleTaskResult.tasks) {
		const existingIdx = combined.tasks.findIndex((t) => t.number === newTask.number);
		if (existingIdx >= 0) {
			combined.tasks[existingIdx] = newTask;
		} else {
			combined.tasks.push(newTask);
		}
	}
	// Sort tasks by number
	combined.tasks.sort((a, b) => a.number - b.number);
}

/**
 * Recompute composite scores from individual task results.
 * Follows the persona scoring formula: composite = p0*0.60 + p1*0.25 + p2*0.15
 */
function recomputeScores(combined: EvalResultsJson): void {
	const tiers: Record<string, number[]> = { P0: [], P1: [], P2: [] };
	for (const task of combined.tasks) {
		const tier = task.tier?.toUpperCase() ?? "P2";
		if (tiers[tier]) {
			tiers[tier].push(task.score);
		}
	}

	const avg = (arr: number[]) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
	const p0 = avg(tiers.P0);
	const p1 = avg(tiers.P1);
	const p2 = avg(tiers.P2);

	let composite = p0 * 0.60 + p1 * 0.25 + p2 * 0.15;

	// If any P0 task scores 0: composite = min(composite, 40)
	if (tiers.P0.some((s) => s === 0)) {
		composite = Math.min(composite, 40);
	}

	combined.composite_score = Math.round(composite * 10) / 10;
	combined.p0_score = Math.round(p0 * 10) / 10;
	combined.p1_score = Math.round(p1 * 10) / 10;
	combined.p2_score = Math.round(p2 * 10) / 10;
}

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
			runs: Type.Optional(
				Type.Number({ description: "Number of evaluation runs per task (default depends on mode: quick=1, full=2, calibrate=3). Higher reduces score variance." }),
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
			const evalResultsPath = path.join(ctx.cwd, iterDir, "eval_results.json");
			const mode = params.mode ?? "full";

			// Decide execution strategy:
			// - If a specific task is requested, run it directly
			// - If calibrate/variants mode, run everything at once (needs all tasks for aggregation)
			// - Otherwise: run tasks individually with per-task timeouts
			const usePerTaskExecution = !params.task && !params.tier && (mode === "quick" || mode === "full");

			if (usePerTaskExecution) {
				return await runPerTask(params, {
					pythonDir, useUv, iterDir, screenshotDir,
					evalResultsPath, mode, signal, onUpdate, ctx,
				});
			} else {
				return await runAllAtOnce(params, {
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
			if (args.tier) text += theme.fg("dim", ` ${args.tier}`);
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

	// ── Per-task execution ──────────────────────────────────────────────
	// Runs each task as a separate evaluate.py invocation with its own timeout.
	// Merges results incrementally and auto-retries timeouts.

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
	 * Compute per-task timeout in milliseconds.
	 * Scales by max_steps and number of runs, with a hard cap.
	 *
	 * NOTE: pi.exec() treats timeout as raw milliseconds (unlike the built-in
	 * Bash tool which accepts seconds). All timeouts passed to pi.exec() must
	 * be in milliseconds.
	 */
	function computeTaskTimeoutMs(maxSteps: number, runs: number): number {
		const timeoutMs = (maxSteps * TIMEOUT_PER_STEP_MS + TASK_OVERHEAD_MS) * runs;
		return Math.min(timeoutMs, MAX_TASK_TIMEOUT_MS);
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
		// The `& echo $!` captures the PID for cleanup.
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

	async function runPerTask(
		params: Record<string, unknown>,
		runCtx: RunContext,
	) {
		const state = getRuntime().state;

		// Parse persona.md to get task numbers
		const taskNumbers = parsePersonaTaskNumbers(
			runCtx.ctx.cwd,
			params.requirements_file as string | undefined,
		);

		if (taskNumbers.length === 0) {
			return {
				content: [{ type: "text", text: "❌ No tasks found in persona.md. Check the file format." }],
				details: {},
			};
		}

		// Issue 7: Delete stale eval_results.json before starting
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

		// Issue 3: Start dev server once and reuse across all tasks
		let devServer: { port: number; cleanup: () => Promise<void> } | null = null;
		try {
			runCtx.onUpdate?.({
				content: [{
					type: "text",
					text: `Starting dev server…`,
				}],
			});
			devServer = await startDevServer(runCtx.ctx.cwd);

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
					maxSteps: params.max_steps as number | undefined,
					runs: params.runs as number | undefined,
					skipFeedback: params.skip_feedback as boolean | undefined,
					requirementsFile: params.requirements_file as string | undefined,
					outputDir: taskOutputDir,
					screenshotDir: runCtx.screenshotDir,
					personaCmd: state.personaCmd!,
					port: devServer.port,
				});

				// Issue 1 & 4: Timeout in ms, scaled by max_steps and runs
				const maxSteps = (params.max_steps as number | undefined) ?? DEFAULT_MAX_STEPS;
				const runsForTask = (params.runs as number | undefined) ?? (runCtx.mode === "quick" ? 1 : 2);
				const taskTimeoutMs = computeTaskTimeoutMs(maxSteps, runsForTask);

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

				// Issue 6: Stream progress with per-task score
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
		} finally {
			// Issue 3: Clean up dev server
			if (devServer) {
				await devServer.cleanup();
			}
		}

		// Final score recompute
		recomputeScores(combined);
		fs.writeFileSync(runCtx.evalResultsPath, JSON.stringify(combined, null, 2));

		// Build response
		return buildResponse(combined, runCtx.evalResultsPath, timedOutCount);
	}

	// ── All-at-once execution ───────────────────────────────────────────
	// Used for calibrate, variants, or single-task runs.

	async function runAllAtOnce(
		params: Record<string, unknown>,
		runCtx: RunContext,
	) {
		const state = getRuntime().state;

		// Issue 7: Delete stale eval_results.json before starting
		if (fs.existsSync(runCtx.evalResultsPath)) {
			fs.unlinkSync(runCtx.evalResultsPath);
		}

		const command = buildEvaluateCommand({
			pythonDir: runCtx.pythonDir,
			useUv: runCtx.useUv,
			iteration: params.iteration as number,
			mode: runCtx.mode,
			task: params.task as number | undefined,
			tier: params.tier as string | undefined,
			variantCount: (params.variant_count as number | undefined) ?? 4,
			maxSteps: params.max_steps as number | undefined,
			runs: params.runs as number | undefined,
			skipFeedback: params.skip_feedback as boolean | undefined,
			requirementsFile: params.requirements_file as string | undefined,
			outputDir: runCtx.iterDir,
			screenshotDir: runCtx.screenshotDir,
			personaCmd: state.personaCmd!,
		});

		// Estimate task count for timeout — all in milliseconds
		// NOTE: pi.exec() treats timeout as raw milliseconds
		const taskNumbers = parsePersonaTaskNumbers(
			runCtx.ctx.cwd,
			params.requirements_file as string | undefined,
		);
		const numTasks = params.task ? 1 : taskNumbers.length || 7;
		const maxSteps = (params.max_steps as number | undefined) ?? DEFAULT_MAX_STEPS;
		const runsMultiplier = runCtx.mode === "calibrate" ? 3 : runCtx.mode === "variants" ? ((params.variant_count as number) || 4) : 2;
		const timeoutMs = TIMEOUT_BASE_MS + (numTasks * computeTaskTimeoutMs(maxSteps, runsMultiplier));

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
