/**
 * Pure logic for evaluation result processing.
 *
 * Extracted from evaluate.ts so these functions can be tested
 * without mocking the pi ExtensionAPI.
 */

import * as fs from "node:fs";

// Default max steps per task (must match evaluate.py DEFAULT_MAX_STEPS)
export const DEFAULT_MAX_STEPS = 15;
// Quick mode max steps (must match evaluate.py --quick default)
export const QUICK_MAX_STEPS = 10;

// Timeout per step: ~60s covers LLM call (~30-50s) + screenshot + browser action + wait
export const TIMEOUT_PER_STEP_MS = 60_000;

// Scoring/feedback overhead per task (LLM scoring call + optional feedback call)
export const TASK_OVERHEAD_MS = 60_000;

// Hard cap to avoid infinite waits on a single task
export const MAX_TASK_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

export interface TaskResultJson {
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

export interface SessionWishlist {
	wishlist: string[];
	surprise: string;
	would_use: string;
}

export interface EvalResultsJson {
	composite_score: number;
	p0_score: number;
	p1_score: number;
	p2_score: number;
	tasks: TaskResultJson[];
	exploratory_tasks?: TaskResultJson[];
	exploratory_score?: number;
	session_wishlist?: SessionWishlist;
	[key: string]: unknown;
}

export function readEvalResults(filePath: string): EvalResultsJson | null {
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
export function mergeTaskResult(
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
export function recomputeScores(combined: EvalResultsJson): void {
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

/**
 * Compute per-task timeout in milliseconds.
 * Scales by max_steps and number of runs, with a hard cap.
 *
 * NOTE: pi.exec() treats timeout as raw milliseconds (unlike the built-in
 * Bash tool which accepts seconds). All timeouts passed to pi.exec() must
 * be in milliseconds.
 */
export function computeTaskTimeoutMs(maxSteps: number, runs: number): number {
	const timeoutMs = (maxSteps * TIMEOUT_PER_STEP_MS + TASK_OVERHEAD_MS) * runs;
	return Math.min(timeoutMs, MAX_TASK_TIMEOUT_MS);
}
