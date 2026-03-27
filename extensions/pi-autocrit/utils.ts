/**
 * Utility helpers for pi-autocrit.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AutocritState } from "./state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Dependency checks
// ---------------------------------------------------------------------------

export interface DependencyStatus {
	agentBrowser: boolean;
	uv: boolean;
	python3: boolean;
	git: boolean;
}

export async function checkDependencies(
	exec: (cmd: string, args: string[]) => Promise<{ code: number | null }>,
): Promise<DependencyStatus> {
	const check = async (cmd: string, args: string[]): Promise<boolean> => {
		try {
			const result = await exec(cmd, args);
			return result.code === 0;
		} catch {
			return false;
		}
	};

	return {
		agentBrowser: await check("which", ["agent-browser"]),
		uv: await check("which", ["uv"]),
		python3: await check("which", ["python3"]),
		git: await check("which", ["git"]),
	};
}

export function formatDependencyReport(deps: DependencyStatus): string {
	const lines: string[] = [];
	const ok = "✅";
	const fail = "❌";

	lines.push(`${deps.git ? ok : fail} git`);
	lines.push(`${deps.agentBrowser ? ok : fail} agent-browser`);
	lines.push(`${deps.uv ? ok : fail} uv (Python package manager)`);
	if (!deps.uv) {
		lines.push(`${deps.python3 ? ok : fail} python3 (fallback)`);
	}

	const allGood = deps.git && deps.agentBrowser && (deps.uv || deps.python3);
	if (!allGood) {
		lines.push("");
		lines.push("Missing dependencies:");
		if (!deps.agentBrowser) {
			lines.push("  agent-browser: npm install -g agent-browser && agent-browser install");
		}
		if (!deps.uv && !deps.python3) {
			lines.push("  uv: curl -LsSf https://astral.sh/uv/install.sh | sh");
		}
		if (!deps.git) {
			lines.push("  git: install from https://git-scm.com/");
		}
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Python runner resolution
// ---------------------------------------------------------------------------

export function getPythonDir(): string {
	// Python scripts are bundled in the package at python/
	return path.resolve(__dirname, "../../python");
}

export function buildEvaluateCommand(params: {
	pythonDir: string;
	useUv: boolean;
	iteration?: number;
	mode?: string;
	task?: number;
	tier?: string;
	variantCount?: number;
	maxSteps?: number;
	runs?: number;
	skipFeedback?: boolean;
	requirementsFile?: string;
	outputDir: string;
	screenshotDir: string;
	personaCmd: string;
	port?: number;
}): string {
	const { pythonDir, useUv } = params;
	const evalScript = path.join(pythonDir, "evaluate.py");

	// Issue 2: Clear VIRTUAL_ENV to avoid uv conflicts and startup delays
	// when the parent shell has a different venv activated.
	const parts: string[] = ["unset VIRTUAL_ENV;"];

	if (useUv) {
		// Use --project (not --directory) to resolve python deps from pythonDir
		// without changing the working directory. The script runs in ctx.cwd
		// so it can find package.json, persona.md, src/, etc.
		parts.push("uv", "run", "--project", pythonDir, evalScript);
	} else {
		parts.push("python3", evalScript);
	}

	parts.push("--cmd", JSON.stringify(params.personaCmd));

	if (params.mode === "calibrate") {
		parts.push("--calibrate");
	} else if (params.mode === "quick") {
		parts.push("--quick");
	} else if (params.mode === "variants" && params.variantCount) {
		parts.push("--variants", String(params.variantCount));
	}

	if (params.iteration !== undefined) {
		parts.push("--iteration", String(params.iteration));
	}
	if (params.task !== undefined) {
		parts.push("--task", String(params.task));
	}
	if (params.tier) {
		parts.push("--tier", params.tier);
	}
	if (params.maxSteps !== undefined) {
		parts.push("--max-steps", String(params.maxSteps));
	}
	if (params.runs !== undefined) {
		parts.push("--runs", String(params.runs));
	}
	if (params.skipFeedback) {
		parts.push("--skip-feedback");
	}
	if (params.requirementsFile) {
		parts.push("--requirements", params.requirementsFile);
	}
	if (params.port !== undefined) {
		parts.push("--port", String(params.port));
	}
	parts.push("--output-dir", params.outputDir);
	parts.push("--screenshot-dir", params.screenshotDir);

	return parts.join(" ");
}

export function buildReportCommand(params: {
	pythonDir: string;
	useUv: boolean;
	experimentDir: string;
	hypothesesFile?: string;
}): string {
	const { pythonDir, useUv } = params;
	const reportScript = path.join(pythonDir, "generate_report.py");

	const parts: string[] = [];

	if (useUv) {
		// Use --project (not --directory) to avoid changing cwd
		parts.push("uv", "run", "--project", pythonDir, reportScript);
	} else {
		parts.push("python3", reportScript);
	}

	parts.push(params.experimentDir);

	if (params.hypothesesFile) {
		parts.push("--hypotheses", params.hypothesesFile);
	}

	return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Persona task number extraction (lightweight, no Python needed)
// ---------------------------------------------------------------------------

/**
 * Parse persona.md (and optional requirements.md) to extract task numbers.
 * Looks for "#### Task N:" headers in the markdown.
 */
export function parsePersonaTaskNumbers(cwd: string, requirementsPath?: string): number[] {
	const filePath = requirementsPath
		? path.join(cwd, requirementsPath)
		: path.join(cwd, "persona.md");

	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const taskNumbers: number[] = [];
		// Match "#### Task N:" headers (with optional text after the number)
		const pattern = /^#{1,4}\s+Task\s+(\d+)\s*:/gm;
		let match;
		while ((match = pattern.exec(content)) !== null) {
			taskNumbers.push(parseInt(match[1], 10));
		}
		return taskNumbers;
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Score formatting
// ---------------------------------------------------------------------------

export function formatScoreLine(state: AutocritState): string {
	const iters = state.iterations.filter((r) => r.branch === state.currentBranch);
	if (iters.length === 0) return "no iterations yet";

	const latest = iters[iters.length - 1];
	const prev = iters.length > 1 ? iters[iters.length - 2] : null;
	const delta = prev ? latest.composite - prev.composite : 0;
	const deltaStr = delta > 0 ? `▲+${delta.toFixed(1)}` : delta < 0 ? `▼${delta.toFixed(1)}` : "—";

	return `composite: ${latest.composite.toFixed(1)} (P0: ${latest.p0.toFixed(1)} P1: ${latest.p1.toFixed(1)} P2: ${latest.p2.toFixed(1)}) │ ${deltaStr}`;
}

// ---------------------------------------------------------------------------
// Results file management
// ---------------------------------------------------------------------------

export function appendResultsTsv(resultsDir: string, result: {
	iteration: number;
	composite: number;
	p0: number;
	p1: number;
	p2: number;
	description: string;
	kept: boolean;
}): void {
	const tsvPath = path.join(resultsDir, "results.tsv");
	const keptStr = result.kept ? "kept" : "discarded";
	const line = `${result.iteration}\t${result.composite}\t${result.p0}\t${result.p1}\t${result.p2}\t${result.description}\t${keptStr}\n`;

	if (!fs.existsSync(tsvPath)) {
		fs.writeFileSync(tsvPath, "iteration\tcomposite\tp0\tp1\tp2\tchange_description\tkept\n" + line);
	} else {
		fs.appendFileSync(tsvPath, line);
	}
}

export function appendIterationHistory(resultsDir: string, entry: Record<string, unknown>): void {
	const historyPath = path.join(resultsDir, "iteration_history.jsonl");
	fs.appendFileSync(historyPath, JSON.stringify(entry) + "\n");
}
