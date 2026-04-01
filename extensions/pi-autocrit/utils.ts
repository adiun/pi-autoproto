/**
 * Utility helpers for pi-autocrit.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { AutocritState, IterationResult } from "./state.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// Dependency checks
// ---------------------------------------------------------------------------

export interface DependencyStatus {
	browserBackend: boolean;
	browserBackendName: string;
	browserChromiumInstalled: boolean;
	uv: boolean;
	python3: boolean;
	git: boolean;
}

export async function checkDependencies(
	exec: (cmd: string, args: string[]) => Promise<{ code: number | null; stdout?: string; stderr?: string }>,
	browserBackendName: string = "agent-browser",
): Promise<DependencyStatus> {
	const check = async (cmd: string, args: string[]): Promise<boolean> => {
		try {
			const result = await exec(cmd, args);
			return result.code === 0;
		} catch {
			return false;
		}
	};

	const backendInstalled = await check("which", [browserBackendName]);

	// For playwright-cli, verify chromium is actually installed for the CLI's
	// bundled Playwright version (see Issue 4 in playwright-cli-issues.md).
	let chromiumInstalled = true;
	if (browserBackendName === "playwright-cli" && backendInstalled) {
		chromiumInstalled = await checkPlaywrightChromium(exec);
	}

	return {
		browserBackend: backendInstalled,
		browserBackendName,
		browserChromiumInstalled: chromiumInstalled,
		uv: await check("which", ["uv"]),
		python3: await check("which", ["python3"]),
		git: await check("which", ["git"]),
	};
}

/**
 * Check if chromium is installed for playwright-cli's bundled Playwright version.
 * Runs a quick `playwright-cli` command with PLAYWRIGHT_MCP_BROWSER=chromium to verify.
 */
async function checkPlaywrightChromium(
	exec: (cmd: string, args: string[]) => Promise<{ code: number | null; stdout?: string; stderr?: string }>,
): Promise<boolean> {
	try {
		// Use `playwright-cli browser-status` or a lightweight probe.
		// The simplest reliable check: try to open and immediately close.
		const result = await exec("bash", [
			"-c",
			"PLAYWRIGHT_MCP_BROWSER=chromium playwright-cli -s=__chromium_check open about:blank 2>&1",
		]);
		const output = (result.stdout ?? "") + (result.stderr ?? "");
		// If chromium is missing, the output will contain "not found" or "install"
		if (output.includes("not found") || output.includes("Run \"npx playwright install") || output.includes("is not found")) {
			return false;
		}
		// Also check exit code — non-zero with install message means missing
		if (result.code !== 0 && output.toLowerCase().includes("install")) {
			return false;
		}
		// Clean up the probe session
		try { await exec("bash", ["-c", "playwright-cli -s=__chromium_check close 2>/dev/null"]); } catch { /* ignore */ }
		return result.code === 0;
	} catch {
		return false;
	}
}

/**
 * Resolve the path to playwright-cli's bundled `playwright/cli.js`.
 * This is needed because `npx playwright install chromium` installs for the
 * project-local Playwright, not the one bundled with @playwright/cli.
 */
export async function resolvePlaywrightCliJsPath(
	exec: (cmd: string, args: string[]) => Promise<{ code: number | null; stdout?: string }>,
): Promise<string | null> {
	try {
		// Resolve the playwright-cli binary location, then navigate to its node_modules
		const result = await exec("bash", [
			"-c",
			"node -e \"console.log(require.resolve('@playwright/cli/package.json'))\"",
		]);
		if (result.code !== 0 || !result.stdout?.trim()) {
			// Fallback: resolve from the binary symlink
			const whichResult = await exec("bash", [
				"-c",
				"realpath $(which playwright-cli) 2>/dev/null || readlink -f $(which playwright-cli) 2>/dev/null",
			]);
			if (whichResult.code !== 0 || !whichResult.stdout?.trim()) return null;
			const binPath = whichResult.stdout.trim();
			// Navigate: bin -> package root -> node_modules/playwright/cli.js
			const pkgRoot = path.resolve(path.dirname(binPath), "..");
			const cliJs = path.join(pkgRoot, "node_modules", "playwright", "cli.js");
			return fs.existsSync(cliJs) ? cliJs : null;
		}
		const pkgJson = result.stdout.trim();
		const pkgDir = path.dirname(pkgJson);
		const cliJs = path.join(pkgDir, "node_modules", "playwright", "cli.js");
		return fs.existsSync(cliJs) ? cliJs : null;
	} catch {
		return null;
	}
}

/**
 * Install chromium for playwright-cli's bundled Playwright version.
 * Returns true on success.
 */
export async function installPlaywrightChromium(
	exec: (cmd: string, args: string[]) => Promise<{ code: number | null; stdout?: string; stderr?: string }>,
): Promise<{ success: boolean; message: string }> {
	const cliJs = await resolvePlaywrightCliJsPath(exec);
	if (!cliJs) {
		return {
			success: false,
			message: "Could not resolve playwright-cli's bundled Playwright path. "
				+ "Manual fix: find the CLI's node_modules and run: node <path>/playwright/cli.js install chromium",
		};
	}

	try {
		const result = await exec("node", [cliJs, "install", "chromium"]);
		const output = (result.stdout ?? "") + (result.stderr ?? "");
		if (result.code === 0) {
			return { success: true, message: `Installed chromium via ${cliJs}` };
		}
		return {
			success: false,
			message: `chromium install failed (exit ${result.code}): ${output.slice(0, 300)}`,
		};
	} catch (e) {
		return { success: false, message: `chromium install error: ${e}` };
	}
}

export function formatDependencyReport(deps: DependencyStatus): string {
	const lines: string[] = [];
	const ok = "✅";
	const fail = "❌";

	lines.push(`${deps.git ? ok : fail} git`);
	lines.push(`${deps.browserBackend ? ok : fail} ${deps.browserBackendName}`);
	if (deps.browserBackendName === "playwright-cli" && deps.browserBackend) {
		lines.push(`${deps.browserChromiumInstalled ? ok : "⚠️"} chromium (for playwright-cli)`);
	}
	lines.push(`${deps.uv ? ok : fail} uv (Python package manager)`);
	if (!deps.uv) {
		lines.push(`${deps.python3 ? ok : fail} python3 (fallback)`);
	}

	const allGood = deps.git && deps.browserBackend && deps.browserChromiumInstalled && (deps.uv || deps.python3);
	if (!allGood) {
		lines.push("");
		lines.push("Missing dependencies:");
		if (!deps.browserBackend) {
			if (deps.browserBackendName === "playwright-cli") {
				lines.push("  playwright-cli: npm install -g @playwright/cli@latest");
			} else {
				lines.push("  agent-browser: npm install -g agent-browser && agent-browser install");
			}
		} else if (deps.browserBackendName === "playwright-cli" && !deps.browserChromiumInstalled) {
			lines.push("  chromium: init_autocrit will auto-install, or manually:");
			lines.push("    CLI_PKG=$(node -e \"console.log(require.resolve('@playwright/cli/package.json'))\")");
			lines.push("    node $(dirname $CLI_PKG)/node_modules/playwright/cli.js install chromium");
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
	variantCount?: number;
	outputDir: string;
	screenshotDir: string;
	personaCmd: string;
	port?: number;
	browserBackend?: string;
	postEval?: boolean;
	maxSteps?: number;
}): string {
	const { pythonDir, useUv } = params;
	const evalScript = path.join(pythonDir, "evaluate.py");

	// Clear VIRTUAL_ENV to avoid uv conflicts and startup delays
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

	if (params.mode === "quick") {
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
	if (params.port !== undefined) {
		parts.push("--port", String(params.port));
	}
	parts.push("--output-dir", params.outputDir);
	parts.push("--screenshot-dir", params.screenshotDir);
	if (params.browserBackend) {
		parts.push("--browser-backend", params.browserBackend);
	}
	if (params.postEval) {
		parts.push("--post-eval");
	}
	if (params.maxSteps !== undefined) {
		parts.push("--max-steps", String(params.maxSteps));
	}

	return parts.join(" ");
}

export function buildGenerateTasksCommand(params: {
	pythonDir: string;
	useUv: boolean;
	personaCmd: string;
	appDescription: string;
	write?: boolean;
}): string {
	const { pythonDir, useUv } = params;
	const script = path.join(pythonDir, "generate_tasks.py");

	const parts: string[] = ["unset VIRTUAL_ENV;"];

	if (useUv) {
		parts.push("uv", "run", "--project", pythonDir, script);
	} else {
		parts.push("python3", script);
	}

	parts.push("--cmd", JSON.stringify(params.personaCmd));
	parts.push("--app", JSON.stringify(params.appDescription));
	if (params.write) {
		parts.push("--write");
	}

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

/** Lightweight task metadata parsed from persona.md headers. */
export interface TaskMetadata {
	number: number;
	/** Per-task max_steps override (null = use global default). */
	maxSteps: number | null;
}

/**
 * Parse persona.md (and optional requirements.md) to extract task numbers.
 * Looks for "#### Task N:" headers in the markdown.
 */
export function parsePersonaTaskNumbers(cwd: string, requirementsPath?: string): number[] {
	return parsePersonaTaskMetadata(cwd, requirementsPath).map((m) => m.number);
}

/**
 * Parse persona.md to extract task numbers and per-task max_steps.
 * Looks for "#### Task N:" headers and "- max_steps: N" fields.
 */
export function parsePersonaTaskMetadata(cwd: string, requirementsPath?: string): TaskMetadata[] {
	const filePath = requirementsPath
		? path.join(cwd, requirementsPath)
		: path.join(cwd, "persona.md");

	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const tasks: TaskMetadata[] = [];
		const lines = content.split("\n");

		let currentTaskNumber: number | null = null;
		let currentMaxSteps: number | null = null;
		const taskHeaderPattern = /^#{1,4}\s+Task\s+(\d+)\s*:/;
		const maxStepsPattern = /^-\s*max_steps:\s*(\d+)/;

		for (const line of lines) {
			const taskMatch = taskHeaderPattern.exec(line);
			if (taskMatch) {
				// Save previous task if any
				if (currentTaskNumber !== null) {
					tasks.push({ number: currentTaskNumber, maxSteps: currentMaxSteps });
				}
				currentTaskNumber = parseInt(taskMatch[1], 10);
				currentMaxSteps = null;
				continue;
			}
			if (currentTaskNumber !== null) {
				const stepsMatch = maxStepsPattern.exec(line);
				if (stepsMatch) {
					currentMaxSteps = parseInt(stepsMatch[1], 10);
				}
			}
		}
		// Don't forget the last task
		if (currentTaskNumber !== null) {
			tasks.push({ number: currentTaskNumber, maxSteps: currentMaxSteps });
		}

		return tasks;
	} catch {
		return [];
	}
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

/**
 * Format a duration in milliseconds as a human-readable string.
 * < 60s: "42s", < 60m: "12m 34s", >= 60m: "1h 23m"
 */
export function formatDuration(ms: number): string {
	if (ms < 0) return "0s";
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;

	if (hours > 0) {
		return `${hours}h ${minutes}m`;
	}
	if (minutes > 0) {
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
}

/**
 * Get elapsed milliseconds since session start. Returns 0 if no startTime.
 */
export function getElapsedMs(state: AutocritState): number {
	if (!state.startTime) return 0;
	return Date.now() - state.startTime;
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

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

const SPARK_CHARS = "▁▂▃▄▅▆▇█";

/**
 * Generate a sparkline string from an array of numbers.
 * Uses Unicode block characters to show a trend.
 */
export function sparkline(values: number[]): string {
	if (values.length === 0) return "";
	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = max - min || 1;
	return values
		.map((v) => {
			const idx = Math.round(((v - min) / range) * (SPARK_CHARS.length - 1));
			return SPARK_CHARS[idx];
		})
		.join("");
}
