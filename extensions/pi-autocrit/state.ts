/**
 * State management for pi-autocrit.
 *
 * Tracks experiment mode, prototype branches, iteration history,
 * and scores. Persists to autocrit.jsonl for cross-session continuity.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutocritMode = "full" | "quick";

export interface IterationResult {
	iteration: number;
	composite: number;
	p0: number;
	p1: number;
	p2: number;
	description: string;
	kept: boolean;
	branch: string;
	timestamp: number;
}

/** Per-task score entry tracked across iterations for variance/stuck detection. */
export interface TaskScoreEntry {
	iteration: number;
	taskNumber: number;
	taskName: string;
	tier: string;
	score: number;
	stuckPoints: string[];
	branch: string;
}

export interface AutocritState {
	/** Whether autocrit mode is active */
	active: boolean;
	/** full (3 prototypes) or quick (single) */
	mode: AutocritMode;
	/** Short experiment name, e.g. "tipcalc" */
	experimentName: string | null;
	/** Command to use for persona agent, e.g. "claude -p" */
	personaCmd: string | null;
	/** Git branches for each prototype */
	branches: string[];
	/** Currently active branch */
	currentBranch: string | null;
	/** Iteration results per branch */
	iterations: IterationResult[];
	/** Results directory base */
	resultsDir: string | null;
	/** Timestamp (ms) when the autocrit session was started */
	startTime: number | null;
	/** Per-task score history for variance tracking and stuck detection */
	taskScores: TaskScoreEntry[];
	/** Task numbers marked as blocked (excluded from composite scoring) */
	blockedTasks: number[];
	/** Max iterations per prototype in full mode (default 5) */
	maxIterationsPerPrototype: number;
}

export interface AutocritRuntime {
	state: AutocritState;
	/** Port of the cached dev server (reused across evaluations) */
	devServerPort: number | null;
	/** Cleanup function for the cached dev server */
	devServerCleanup: (() => Promise<void>) | null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

export function createState(): AutocritState {
	return {
		active: false,
		mode: "quick",
		experimentName: null,
		personaCmd: null,
		branches: [],
		currentBranch: null,
		iterations: [],
		resultsDir: null,
		startTime: null,
		taskScores: [],
		blockedTasks: [],
		maxIterationsPerPrototype: 5,
	};
}

export function createRuntime(): AutocritRuntime {
	return {
		state: createState(),
		devServerPort: null,
		devServerCleanup: null,
	};
}

// ---------------------------------------------------------------------------
// Persistence — autocrit.jsonl
// ---------------------------------------------------------------------------

export function getJsonlPath(cwd: string): string {
	return path.join(cwd, "autocrit.jsonl");
}

export function writeConfig(cwd: string, state: AutocritState): void {
	const jsonlPath = getJsonlPath(cwd);
	const config = JSON.stringify({
		type: "config",
		mode: state.mode,
		experiment: state.experimentName,
		personaCmd: state.personaCmd,
		branches: state.branches,
		resultsDir: state.resultsDir,
		startTime: state.startTime,
		blockedTasks: state.blockedTasks.length > 0 ? state.blockedTasks : undefined,
		maxIterationsPerPrototype: state.maxIterationsPerPrototype !== 5 ? state.maxIterationsPerPrototype : undefined,
	});
	fs.writeFileSync(jsonlPath, config + "\n");
}

export function appendIteration(cwd: string, result: IterationResult): void {
	const jsonlPath = getJsonlPath(cwd);
	const line = JSON.stringify({
		type: "iteration",
		...result,
	});
	fs.appendFileSync(jsonlPath, line + "\n");
}

export function appendTaskScores(cwd: string, entries: TaskScoreEntry[]): void {
	const jsonlPath = getJsonlPath(cwd);
	for (const entry of entries) {
		const line = JSON.stringify({
			type: "task_score",
			...entry,
		});
		fs.appendFileSync(jsonlPath, line + "\n");
	}
}

export function reconstructState(cwd: string): AutocritState {
	const state = createState();
	const jsonlPath = getJsonlPath(cwd);

	try {
		if (!fs.existsSync(jsonlPath)) return state;

		const lines = fs.readFileSync(jsonlPath, "utf-8").trim().split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const entry = JSON.parse(line);
				if (entry.type === "config") {
					state.active = true;
					state.mode = entry.mode ?? "quick";
					state.experimentName = entry.experiment ?? null;
					state.personaCmd = entry.personaCmd ?? null;
					state.browserBackend = entry.browserBackend ?? "agent-browser";
					state.branches = entry.branches ?? [];
					state.resultsDir = entry.resultsDir ?? null;
					state.startTime = entry.startTime ?? null;
					state.blockedTasks = entry.blockedTasks ?? [];
					state.maxIterationsPerPrototype = entry.maxIterationsPerPrototype ?? 5;
				} else if (entry.type === "iteration") {
					state.iterations.push({
						iteration: entry.iteration ?? 0,
						composite: entry.composite ?? 0,
						p0: entry.p0 ?? 0,
						p1: entry.p1 ?? 0,
						p2: entry.p2 ?? 0,
						description: entry.description ?? "",
						kept: entry.kept ?? true,
						branch: entry.branch ?? "",
						timestamp: entry.timestamp ?? 0,
					});
				} else if (entry.type === "task_score") {
					state.taskScores.push({
						iteration: entry.iteration ?? 0,
						taskNumber: entry.taskNumber ?? 0,
						taskName: entry.taskName ?? "",
						tier: entry.tier ?? "",
						score: entry.score ?? 0,
						stuckPoints: entry.stuckPoints ?? [],
						branch: entry.branch ?? "",
					});
				}
			} catch {
				// skip malformed lines
			}
		}
	} catch {
		// file doesn't exist or can't be read
	}

	return state;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function currentBranchIterations(state: AutocritState): IterationResult[] {
	if (!state.currentBranch) return state.iterations;
	return state.iterations.filter((r) => r.branch === state.currentBranch);
}

export function latestIteration(state: AutocritState): IterationResult | null {
	const iters = currentBranchIterations(state);
	return iters.length > 0 ? iters[iters.length - 1] : null;
}

export function bestIteration(state: AutocritState): IterationResult | null {
	const kept = currentBranchIterations(state).filter((r) => r.kept);
	if (kept.length === 0) return null;
	return kept.reduce((best, r) => (r.composite > best.composite ? r : best));
}

export function isPlateaued(state: AutocritState): boolean {
	const kept = currentBranchIterations(state).filter((r) => r.kept);
	if (kept.length < 4) return false;
	const last3 = kept.slice(-3);
	const ref = kept[kept.length - 4].composite;
	return last3.every((r) => r.composite - ref <= 3);
}

// ---------------------------------------------------------------------------
// Task score history helpers
// ---------------------------------------------------------------------------

/** Get score history for a specific task on the current branch. */
export function taskScoreHistory(state: AutocritState, taskNumber: number): TaskScoreEntry[] {
	const branch = state.currentBranch;
	return state.taskScores.filter((e) =>
		e.taskNumber === taskNumber && (!branch || e.branch === branch),
	);
}

/** Detect structurally stuck tasks: scored 0 in N+ consecutive kept iterations with step-limit stuck points. */
export function detectStuckTasks(state: AutocritState, minConsecutive: number = 3): Array<{ taskNumber: number; taskName: string; tier: string; consecutiveZeros: number }> {
	const keptIters = currentBranchIterations(state).filter((r) => r.kept);
	if (keptIters.length < minConsecutive) return [];

	// Group task scores by task number, only from kept iterations
	const keptIterNums = new Set(keptIters.map((r) => r.iteration));
	const branch = state.currentBranch;
	const byTask = new Map<number, TaskScoreEntry[]>();
	for (const entry of state.taskScores) {
		if (branch && entry.branch !== branch) continue;
		if (!keptIterNums.has(entry.iteration)) continue;
		if (!byTask.has(entry.taskNumber)) byTask.set(entry.taskNumber, []);
		byTask.get(entry.taskNumber)!.push(entry);
	}

	const stuck: Array<{ taskNumber: number; taskName: string; tier: string; consecutiveZeros: number }> = [];
	for (const [taskNum, entries] of byTask) {
		// Sort by iteration and count trailing consecutive zeros with step-limit stuck
		entries.sort((a, b) => a.iteration - b.iteration);
		let consecutiveZeros = 0;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			const isStepLimited = e.stuckPoints.some((sp) =>
				sp.toLowerCase().includes("step limit") || sp.toLowerCase().includes("maximum step"),
			);
			if (e.score === 0 && isStepLimited) {
				consecutiveZeros++;
			} else {
				break;
			}
		}
		if (consecutiveZeros >= minConsecutive) {
			const last = entries[entries.length - 1];
			stuck.push({ taskNumber: taskNum, taskName: last.taskName, tier: last.tier, consecutiveZeros });
		}
	}
	return stuck;
}

/** Compute per-task score statistics (mean, stdev, range) for variance tracking. */
export function taskScoreStats(state: AutocritState, taskNumber: number): {
	mean: number;
	stdev: number;
	min: number;
	max: number;
	count: number;
} | null {
	const history = taskScoreHistory(state, taskNumber);
	if (history.length < 2) return null;
	const scores = history.map((e) => e.score);
	const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
	const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
	const stdev = Math.sqrt(variance);
	return {
		mean: Math.round(mean * 10) / 10,
		stdev: Math.round(stdev * 10) / 10,
		min: Math.min(...scores),
		max: Math.max(...scores),
		count: scores.length,
	};
}

/** Compute composite score stdev across iterations on current branch. */
export function compositeScoreStats(state: AutocritState): { mean: number; stdev: number; count: number } | null {
	const iters = currentBranchIterations(state);
	if (iters.length < 3) return null;
	const scores = iters.map((r) => r.composite);
	const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
	const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length;
	const stdev = Math.sqrt(variance);
	return {
		mean: Math.round(mean * 10) / 10,
		stdev: Math.round(stdev * 10) / 10,
		count: scores.length,
	};
}
