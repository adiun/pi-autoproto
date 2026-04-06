/**
 * T5 (continued): Log tool behavior tests
 *
 * Tests score auto-read, plateau detection, stopping conditions,
 * and revert/commit suggestions.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createMockPi, type MockPi } from "./mock-pi.js";
import { createRuntime, type AutoprotoRuntime } from "../extensions/pi-autoproto/state.js";
import { registerLogTool } from "../extensions/pi-autoproto/tools/log.js";

let mock: MockPi;
let runtime: AutoprotoRuntime;
let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoproto-log-test-"));
	mock = createMockPi();
	runtime = createRuntime();
	runtime.state.active = true;
	runtime.state.resultsDir = "results";
	runtime.state.currentBranch = "main";
	const getRuntime = () => runtime;
	registerLogTool(mock.pi as any, getRuntime);
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeEvalResults(dir: string, iteration: number, scores: { composite: number; p0: number; p1: number; p2: number }) {
	const iterDir = path.join(dir, "results", `iter_${iteration}`);
	fs.mkdirSync(iterDir, { recursive: true });
	fs.writeFileSync(path.join(iterDir, "eval_results.json"), JSON.stringify({
		composite_score: scores.composite,
		p0_score: scores.p0,
		p1_score: scores.p1,
		p2_score: scores.p2,
		tasks: [],
	}));
}

async function callLog(params: Record<string, unknown>) {
	const tool = mock.getTool("log_iteration")!;
	return await tool.execute("call-1", params, undefined, undefined, { cwd: tmpDir }) as {
		content: Array<{ type: string; text: string }>;
		details: Record<string, unknown>;
	};
}

describe("log_iteration score auto-read", () => {
	it("auto-reads scores from eval_results.json when scores omitted", async () => {
		writeEvalResults(tmpDir, 0, { composite: 75.5, p0: 80, p1: 60, p2: 50 });

		// Write a jsonl config so reconstructState knows we're active
		const jsonlPath = path.join(tmpDir, "autoproto.jsonl");
		fs.writeFileSync(jsonlPath, JSON.stringify({ type: "config", mode: "quick", experiment: "test", resultsDir: "results" }) + "\n");

		const result = await callLog({
			iteration: 0,
			description: "baseline",
			kept: true,
		});

		const text = result.content[0].text;
		assert.ok(text.includes("75.5"), `Expected composite 75.5 in: ${text}`);
		assert.ok(text.includes("80.0"), `Expected P0 80.0 in: ${text}`);
	});

	it("returns error when scores omitted and no eval_results.json", async () => {
		const result = await callLog({
			iteration: 0,
			description: "baseline",
			kept: true,
		});

		const text = result.content[0].text;
		assert.ok(text.includes("❌"), `Expected error in: ${text}`);
	});
});

describe("log_iteration output", () => {
	it("detects plateau with sufficient kept iterations", async () => {
		// Pre-populate 3 plateaued iterations
		runtime.state.iterations = [
			{ iteration: 0, composite: 80, p0: 80, p1: 80, p2: 80, description: "a", kept: true, branch: "main", timestamp: 1 },
			{ iteration: 1, composite: 81, p0: 81, p1: 81, p2: 81, description: "b", kept: true, branch: "main", timestamp: 2 },
			{ iteration: 2, composite: 82, p0: 82, p1: 82, p2: 82, description: "c", kept: true, branch: "main", timestamp: 3 },
		];

		writeEvalResults(tmpDir, 3, { composite: 82.5, p0: 82, p1: 83, p2: 82 });

		const result = await callLog({
			iteration: 3,
			description: "tiny change",
			kept: true,
		});

		const text = result.content[0].text;
		assert.ok(text.includes("PLATEAU"), `Expected plateau warning in: ${text}`);
	});

	it("shows stopping condition when P0=100 and composite>85", async () => {
		writeEvalResults(tmpDir, 1, { composite: 90, p0: 100, p1: 80, p2: 70 });

		const result = await callLog({
			iteration: 1,
			description: "all passing",
			kept: true,
		});

		const text = result.content[0].text;
		assert.ok(text.includes("🎉") || text.includes("Consider stopping"), `Expected stop signal in: ${text}`);
	});

	it("suggests revert for discarded iteration", async () => {
		writeEvalResults(tmpDir, 1, { composite: 40, p0: 30, p1: 50, p2: 40 });

		const result = await callLog({
			iteration: 1,
			description: "bad change",
			kept: false,
		});

		const text = result.content[0].text;
		assert.ok(text.includes("revert") || text.includes("git checkout"), `Expected revert suggestion in: ${text}`);
	});

	it("suggests commit for kept iteration", async () => {
		writeEvalResults(tmpDir, 1, { composite: 80, p0: 90, p1: 70, p2: 60 });

		const result = await callLog({
			iteration: 1,
			description: "good change",
			kept: true,
		});

		const text = result.content[0].text;
		assert.ok(text.includes("commit") || text.includes("git add"), `Expected commit suggestion in: ${text}`);
	});
});
