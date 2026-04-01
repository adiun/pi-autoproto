/**
 * T2: Utility helpers tests (utils.ts)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	buildEvaluateCommand, buildReportCommand, parsePersonaTaskNumbers,
	parsePersonaTaskMetadata,
	formatScoreLine, appendResultsTsv, appendIterationHistory,
	formatDuration, getElapsedMs, sparkline,
} from "../extensions/pi-autocrit/utils.js";
import { createState, type AutocritState } from "../extensions/pi-autocrit/state.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocrit-utils-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── formatDuration ──────────────────────────────────────────────────────

describe("formatDuration", () => {
	it("formats seconds only", () => {
		assert.strictEqual(formatDuration(42_000), "42s");
	});

	it("formats minutes and seconds", () => {
		assert.strictEqual(formatDuration(754_000), "12m 34s");
	});

	it("formats hours and minutes", () => {
		assert.strictEqual(formatDuration(4_980_000), "1h 23m");
	});

	it("handles zero", () => {
		assert.strictEqual(formatDuration(0), "0s");
	});

	it("handles negative", () => {
		assert.strictEqual(formatDuration(-100), "0s");
	});

	it("handles exactly 60 seconds", () => {
		assert.strictEqual(formatDuration(60_000), "1m 0s");
	});

	it("handles exactly 1 hour", () => {
		assert.strictEqual(formatDuration(3_600_000), "1h 0m");
	});
});

// ── getElapsedMs ────────────────────────────────────────────────────────

describe("getElapsedMs", () => {
	it("returns 0 when startTime is null", () => {
		const state = createState();
		assert.strictEqual(getElapsedMs(state), 0);
	});

	it("returns positive elapsed time", () => {
		const state = createState();
		state.startTime = Date.now() - 5000;
		const elapsed = getElapsedMs(state);
		assert.ok(elapsed >= 4900 && elapsed <= 6000, `Expected ~5000 but got ${elapsed}`);
	});
});

// ── sparkline ───────────────────────────────────────────────────────────

describe("sparkline", () => {
	it("returns empty string for empty array", () => {
		assert.strictEqual(sparkline([]), "");
	});

	it("returns single block for single value", () => {
		const result = sparkline([50]);
		assert.strictEqual(result.length, 1);
	});

	it("returns correct length for multiple values", () => {
		const result = sparkline([10, 20, 30, 40, 50]);
		assert.strictEqual(result.length, 5);
	});

	it("lowest value gets lowest block, highest gets highest", () => {
		const result = sparkline([0, 100]);
		assert.strictEqual(result[0], "\u2581"); // lowest block
		assert.strictEqual(result[1], "\u2588"); // highest block
	});

	it("equal values produce same block", () => {
		const result = sparkline([50, 50, 50]);
		assert.ok(result[0] === result[1] && result[1] === result[2]);
	});
});

// ── buildEvaluateCommand ────────────────────────────────────────────────

describe("buildEvaluateCommand", () => {
	const base = {
		pythonDir: "/opt/python",
		useUv: true,
		outputDir: "results/iter_0",
		screenshotDir: "results/iter_0/screenshots",
		personaCmd: "pi -p",
	};

	it("mode=quick produces --quick", () => {
		const cmd = buildEvaluateCommand({ ...base, mode: "quick" });
		assert.ok(cmd.includes("--quick"), `Expected --quick in: ${cmd}`);
	});

	it("mode=full produces no mode flag", () => {
		const cmd = buildEvaluateCommand({ ...base, mode: "full" });
		assert.ok(!cmd.includes("--quick"), `Should not have --quick in: ${cmd}`);
		assert.ok(!cmd.includes("--variants"), `Should not have --variants in: ${cmd}`);
		assert.ok(!cmd.includes("--calibrate"), `Should not have --calibrate in: ${cmd}`);
	});

	it("mode=variants produces --variants N", () => {
		const cmd = buildEvaluateCommand({ ...base, mode: "variants", variantCount: 4 });
		assert.ok(cmd.includes("--variants 4"), `Expected --variants 4 in: ${cmd}`);
	});

	it("includes --task N when task specified", () => {
		const cmd = buildEvaluateCommand({ ...base, task: 3 });
		assert.ok(cmd.includes("--task 3"), `Expected --task 3 in: ${cmd}`);
	});

	it("includes --port N when port specified", () => {
		const cmd = buildEvaluateCommand({ ...base, port: 5173 });
		assert.ok(cmd.includes("--port 5173"), `Expected --port 5173 in: ${cmd}`);
	});

	it("does NOT include removed parameters (Plan 3 regression)", () => {
		const cmd = buildEvaluateCommand({ ...base, mode: "quick" });
		const forbidden = ["--tier", "--max-steps", "--runs", "--skip-feedback", "--requirements", "--calibrate"];
		for (const flag of forbidden) {
			assert.ok(!cmd.includes(flag), `Should NOT contain ${flag} in: ${cmd}`);
		}
	});

	it("useUv=true produces uv run --project", () => {
		const cmd = buildEvaluateCommand({ ...base, useUv: true });
		assert.ok(cmd.includes("uv run --project"), `Expected uv run --project in: ${cmd}`);
	});

	it("useUv=false produces python3", () => {
		const cmd = buildEvaluateCommand({ ...base, useUv: false });
		assert.ok(cmd.includes("python3"), `Expected python3 in: ${cmd}`);
		assert.ok(!cmd.includes("uv run"), `Should not have uv run in: ${cmd}`);
	});

	it("starts with unset VIRTUAL_ENV", () => {
		const cmd = buildEvaluateCommand({ ...base });
		assert.ok(cmd.startsWith("unset VIRTUAL_ENV;"), `Expected to start with unset VIRTUAL_ENV; in: ${cmd}`);
	});
});

// ── parsePersonaTaskNumbers ─────────────────────────────────────────────

describe("parsePersonaTaskNumbers", () => {
	it("extracts task numbers from persona.md", () => {
		const personaPath = path.join(tmpDir, "persona.md");
		fs.writeFileSync(personaPath, [
			"# Persona: Test User",
			"## Tasks",
			"### P0",
			"#### Task 1: Basic calc",
			"- goal: do something",
			"#### Task 2: Split bill",
			"- goal: split it",
			"### P1",
			"#### Task 3: Error handling",
			"- goal: handle errors",
			"### P2",
			"#### Task 4: Custom tip",
			"- goal: custom tip",
		].join("\n"));

		const nums = parsePersonaTaskNumbers(tmpDir);
		assert.deepStrictEqual(nums, [1, 2, 3, 4]);
	});

	it("returns empty array for missing file", () => {
		const nums = parsePersonaTaskNumbers("/nonexistent/path");
		assert.deepStrictEqual(nums, []);
	});

	it("returns empty array when no tasks", () => {
		const personaPath = path.join(tmpDir, "persona.md");
		fs.writeFileSync(personaPath, "# Persona: Test User\n## Background\nSome text.\n");

		const nums = parsePersonaTaskNumbers(tmpDir);
		assert.deepStrictEqual(nums, []);
	});

	it("handles multi-level headers (# ## ### ####)", () => {
		const personaPath = path.join(tmpDir, "persona.md");
		fs.writeFileSync(personaPath, [
			"# Task 1: H1 level",
			"## Task 2: H2 level",
			"### Task 3: H3 level",
			"#### Task 4: H4 level",
		].join("\n"));

		const nums = parsePersonaTaskNumbers(tmpDir);
		assert.deepStrictEqual(nums, [1, 2, 3, 4]);
	});

	it("uses requirements file when specified", () => {
		const reqPath = path.join(tmpDir, "requirements.md");
		fs.writeFileSync(reqPath, "#### Task 10: From requirements\n#### Task 20: Another\n");

		const nums = parsePersonaTaskNumbers(tmpDir, "requirements.md");
		assert.deepStrictEqual(nums, [10, 20]);
	});
});

// ── formatScoreLine ─────────────────────────────────────────────────────

describe("formatScoreLine", () => {
	it("shows scores and delta with iterations", () => {
		const state = createState();
		state.currentBranch = "main";
		state.iterations = [
			{ iteration: 0, composite: 50, p0: 60, p1: 40, p2: 30, description: "baseline", kept: true, branch: "main", timestamp: 1 },
			{ iteration: 1, composite: 65, p0: 70, p1: 55, p2: 50, description: "fix nav", kept: true, branch: "main", timestamp: 2 },
		];

		const line = formatScoreLine(state);
		assert.ok(line.includes("65.0"), `Expected 65.0 in: ${line}`);
		assert.ok(line.includes("▲+15.0"), `Expected ▲+15.0 in: ${line}`);
	});

	it("shows placeholder with no iterations", () => {
		const state = createState();
		state.currentBranch = "main";

		const line = formatScoreLine(state);
		assert.ok(line.includes("no iterations yet"), `Expected placeholder in: ${line}`);
	});
});

// ── appendResultsTsv ────────────────────────────────────────────────────

describe("appendResultsTsv", () => {
	it("creates file with header on first call", () => {
		appendResultsTsv(tmpDir, {
			iteration: 0, composite: 50, p0: 60, p1: 40, p2: 30,
			description: "baseline", kept: true,
		});

		const content = fs.readFileSync(path.join(tmpDir, "results.tsv"), "utf-8");
		const lines = content.trim().split("\n");
		assert.strictEqual(lines.length, 2);
		assert.ok(lines[0].includes("iteration"), "First line should be header");
		assert.ok(lines[1].includes("baseline"), "Second line should be data");
	});

	it("appends without header on subsequent calls", () => {
		appendResultsTsv(tmpDir, {
			iteration: 0, composite: 50, p0: 60, p1: 40, p2: 30,
			description: "baseline", kept: true,
		});
		appendResultsTsv(tmpDir, {
			iteration: 1, composite: 65, p0: 70, p1: 55, p2: 50,
			description: "fix nav", kept: true,
		});

		const content = fs.readFileSync(path.join(tmpDir, "results.tsv"), "utf-8");
		const lines = content.trim().split("\n");
		assert.strictEqual(lines.length, 3); // header + 2 data
		// Only one header line
		const headerCount = lines.filter((l) => l.includes("iteration\t")).length;
		assert.strictEqual(headerCount, 1);
	});
});

// ── appendIterationHistory ──────────────────────────────────────────────

describe("appendIterationHistory", () => {
	it("appends JSONL lines", () => {
		appendIterationHistory(tmpDir, { iteration: 0, composite: 50, description: "baseline" });
		appendIterationHistory(tmpDir, { iteration: 1, composite: 65, description: "fix nav" });

		const content = fs.readFileSync(path.join(tmpDir, "iteration_history.jsonl"), "utf-8");
		const lines = content.trim().split("\n");
		assert.strictEqual(lines.length, 2);

		const parsed0 = JSON.parse(lines[0]);
		assert.strictEqual(parsed0.iteration, 0);
		assert.strictEqual(parsed0.composite, 50);

		const parsed1 = JSON.parse(lines[1]);
		assert.strictEqual(parsed1.iteration, 1);
		assert.strictEqual(parsed1.description, "fix nav");
	});
});

// ── parsePersonaTaskMetadata ────────────────────────────────────────────

describe("parsePersonaTaskMetadata", () => {
	it("extracts task numbers and max_steps", () => {
		const personaPath = path.join(tmpDir, "persona.md");
		fs.writeFileSync(personaPath, [
			"#### Task 1: Basic calc",
			"- type: computation",
			"- max_steps: 15",
			"- goal: do something",
			"#### Task 2: Simple nav",
			"- type: navigation",
			"- goal: navigate somewhere",
			"#### Task 3: Complex task",
			"- type: computation",
			"- max_steps: 20",
			"- goal: do complex thing",
		].join("\n"));

		const metas = parsePersonaTaskMetadata(tmpDir);
		assert.strictEqual(metas.length, 3);
		assert.strictEqual(metas[0].number, 1);
		assert.strictEqual(metas[0].maxSteps, 15);
		assert.strictEqual(metas[1].number, 2);
		assert.strictEqual(metas[1].maxSteps, null);
		assert.strictEqual(metas[2].number, 3);
		assert.strictEqual(metas[2].maxSteps, 20);
	});

	it("returns empty array for missing file", () => {
		const metas = parsePersonaTaskMetadata("/nonexistent/path");
		assert.deepStrictEqual(metas, []);
	});

	it("returns null maxSteps when not specified", () => {
		const personaPath = path.join(tmpDir, "persona.md");
		fs.writeFileSync(personaPath, "#### Task 1: Simple\n- goal: test\n");

		const metas = parsePersonaTaskMetadata(tmpDir);
		assert.strictEqual(metas.length, 1);
		assert.strictEqual(metas[0].maxSteps, null);
	});
});

// ── buildEvaluateCommand maxSteps ───────────────────────────────────────

describe("buildEvaluateCommand maxSteps", () => {
	const base = {
		pythonDir: "/opt/python",
		useUv: true,
		iteration: 0,
		outputDir: "results/iter_0",
		screenshotDir: "screenshots",
		personaCmd: "claude -p",
	};

	it("includes --max-steps when specified", () => {
		const cmd = buildEvaluateCommand({ ...base, maxSteps: 20 });
		assert.ok(cmd.includes("--max-steps 20"), `Expected --max-steps 20 in: ${cmd}`);
	});

	it("omits --max-steps when not specified", () => {
		const cmd = buildEvaluateCommand(base);
		assert.ok(!cmd.includes("--max-steps"), `Should not have --max-steps in: ${cmd}`);
	});
});

// ── buildReportCommand ──────────────────────────────────────────────────

describe("buildReportCommand", () => {
	it("produces correct command with uv", () => {
		const cmd = buildReportCommand({
			pythonDir: "/opt/python",
			useUv: true,
			experimentDir: "results/test",
		});
		assert.ok(cmd.includes("uv run"), `Expected uv run in: ${cmd}`);
		assert.ok(cmd.includes("results/test"), `Expected experiment dir in: ${cmd}`);
	});

	it("includes --hypotheses when provided", () => {
		const cmd = buildReportCommand({
			pythonDir: "/opt/python",
			useUv: true,
			experimentDir: "results/test",
			hypothesesFile: "hypotheses.md",
		});
		assert.ok(cmd.includes("--hypotheses hypotheses.md"), `Expected --hypotheses in: ${cmd}`);
	});
});
