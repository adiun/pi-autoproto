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
}

export interface AutocritRuntime {
	state: AutocritState;
	/** Whether the dev server is managed by us */
	devServerPid: number | null;
	/** Port the dev server is on */
	devServerPort: number | null;
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
	};
}

export function createRuntime(): AutocritRuntime {
	return {
		state: createState(),
		devServerPid: null,
		devServerPort: null,
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
					state.branches = entry.branches ?? [];
					state.resultsDir = entry.resultsDir ?? null;
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
