/**
 * T1: State management tests (state.ts)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	createState, createRuntime, writeConfig, reconstructState,
	appendIteration, appendTaskScores, currentBranchIterations, latestIteration,
	bestIteration, isPlateaued, detectStuckTasks, taskScoreStats, taskScoreHistory,
	compositeScoreStats, type AutoprotoState, type IterationResult, type TaskScoreEntry,
} from "../extensions/pi-autoproto/state.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoproto-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeIter(overrides: Partial<IterationResult> = {}): IterationResult {
	return {
		iteration: 0,
		composite: 50,
		p0: 60,
		p1: 40,
		p2: 30,
		description: "test",
		kept: true,
		branch: "main",
		timestamp: Date.now(),
		...overrides,
	};
}

describe("createState", () => {
	it("returns correct defaults", () => {
		const s = createState();
		assert.strictEqual(s.active, false);
		assert.strictEqual(s.mode, "quick");
		assert.strictEqual(s.experimentName, null);
		assert.strictEqual(s.personaCmd, null);
		assert.deepStrictEqual(s.branches, []);
		assert.strictEqual(s.currentBranch, null);
		assert.deepStrictEqual(s.iterations, []);
		assert.strictEqual(s.resultsDir, null);
		assert.strictEqual(s.startTime, null);
	});
});

describe("createRuntime", () => {
	it("returns correct defaults with devServerCleanup", () => {
		const r = createRuntime();
		assert.strictEqual(r.devServerPort, null);
		assert.strictEqual(r.devServerCleanup, null);
		assert.strictEqual(r.state.active, false);
	});
});

describe("writeConfig + reconstructState roundtrip", () => {
	it("persists and reconstructs config", () => {
		const state = createState();
		state.active = true;
		state.mode = "full";
		state.experimentName = "test-exp";
		state.personaCmd = "pi -p";
		state.branches = ["proto-a", "proto-b"];
		state.resultsDir = "results/test";
		state.startTime = 1711600000000;

		writeConfig(tmpDir, state);
		const restored = reconstructState(tmpDir);

		assert.strictEqual(restored.active, true);
		assert.strictEqual(restored.mode, "full");
		assert.strictEqual(restored.experimentName, "test-exp");
		assert.strictEqual(restored.personaCmd, "pi -p");
		assert.deepStrictEqual(restored.branches, ["proto-a", "proto-b"]);
		assert.strictEqual(restored.resultsDir, "results/test");
		assert.strictEqual(restored.startTime, 1711600000000);
	});
});

describe("appendIteration + reconstructState roundtrip", () => {
	it("persists and reconstructs iterations", () => {
		const state = createState();
		state.active = true;
		state.mode = "quick";
		state.experimentName = "test";
		writeConfig(tmpDir, state);

		const iter1 = makeIter({ iteration: 0, composite: 50, description: "baseline" });
		const iter2 = makeIter({ iteration: 1, composite: 65, description: "fix nav" });
		appendIteration(tmpDir, iter1);
		appendIteration(tmpDir, iter2);

		const restored = reconstructState(tmpDir);
		assert.strictEqual(restored.iterations.length, 2);
		assert.strictEqual(restored.iterations[0].composite, 50);
		assert.strictEqual(restored.iterations[1].composite, 65);
		assert.strictEqual(restored.iterations[1].description, "fix nav");
	});
});

describe("reconstructState edge cases", () => {
	it("returns default state for missing file", () => {
		const state = reconstructState("/nonexistent/path/that/does/not/exist");
		assert.strictEqual(state.active, false);
		assert.deepStrictEqual(state.iterations, []);
	});

	it("skips malformed lines", () => {
		const jsonlPath = path.join(tmpDir, "autoproto.jsonl");
		fs.writeFileSync(jsonlPath, [
			'{"type":"config","mode":"quick","experiment":"test"}',
			"this is not json",
			'{"type":"iteration","iteration":0,"composite":50,"p0":60,"p1":40,"p2":30,"description":"ok","kept":true,"branch":"main","timestamp":1}',
			"{}",
		].join("\n") + "\n");

		const state = reconstructState(tmpDir);
		assert.strictEqual(state.active, true);
		assert.strictEqual(state.iterations.length, 1);
		assert.strictEqual(state.iterations[0].composite, 50);
	});
});

describe("currentBranchIterations", () => {
	it("filters by branch", () => {
		const state = createState();
		state.currentBranch = "proto-a";
		state.iterations = [
			makeIter({ branch: "proto-a", iteration: 0 }),
			makeIter({ branch: "proto-b", iteration: 0 }),
			makeIter({ branch: "proto-a", iteration: 1 }),
		];

		const filtered = currentBranchIterations(state);
		assert.strictEqual(filtered.length, 2);
		assert.ok(filtered.every((r) => r.branch === "proto-a"));
	});

	it("returns all iterations when currentBranch is null", () => {
		const state = createState();
		state.currentBranch = null;
		state.iterations = [
			makeIter({ branch: "proto-a" }),
			makeIter({ branch: "proto-b" }),
		];

		const result = currentBranchIterations(state);
		assert.strictEqual(result.length, 2);
	});
});

describe("latestIteration", () => {
	it("returns last iteration for current branch", () => {
		const state = createState();
		state.currentBranch = "main";
		state.iterations = [
			makeIter({ iteration: 0, composite: 50, branch: "main" }),
			makeIter({ iteration: 1, composite: 65, branch: "main" }),
		];

		const latest = latestIteration(state);
		assert.strictEqual(latest?.iteration, 1);
		assert.strictEqual(latest?.composite, 65);
	});

	it("returns null when no iterations", () => {
		const state = createState();
		assert.strictEqual(latestIteration(state), null);
	});
});

describe("bestIteration", () => {
	it("returns highest composite among kept iterations", () => {
		const state = createState();
		state.currentBranch = null;
		state.iterations = [
			makeIter({ iteration: 0, composite: 50, kept: true }),
			makeIter({ iteration: 1, composite: 80, kept: true }),
			makeIter({ iteration: 2, composite: 70, kept: true }),
		];

		const best = bestIteration(state);
		assert.strictEqual(best?.iteration, 1);
		assert.strictEqual(best?.composite, 80);
	});

	it("ignores discarded iterations", () => {
		const state = createState();
		state.currentBranch = null;
		state.iterations = [
			makeIter({ iteration: 0, composite: 50, kept: true }),
			makeIter({ iteration: 1, composite: 90, kept: false }),
			makeIter({ iteration: 2, composite: 60, kept: true }),
		];

		const best = bestIteration(state);
		assert.strictEqual(best?.iteration, 2);
		assert.strictEqual(best?.composite, 60);
	});

	it("returns null when no iterations", () => {
		const state = createState();
		assert.strictEqual(bestIteration(state), null);
	});
});

describe("isPlateaued", () => {
	it("returns false with fewer than 4 kept iterations", () => {
		const state = createState();
		state.currentBranch = null;
		state.iterations = [
			makeIter({ iteration: 0, composite: 50, kept: true }),
			makeIter({ iteration: 1, composite: 52, kept: true }),
			makeIter({ iteration: 2, composite: 53, kept: true }),
		];
		assert.strictEqual(isPlateaued(state), false);
	});

	it("returns true when last 3 within 3pts of reference", () => {
		const state = createState();
		state.currentBranch = null;
		state.iterations = [
			makeIter({ iteration: 0, composite: 80, kept: true }),
			makeIter({ iteration: 1, composite: 81, kept: true }),
			makeIter({ iteration: 2, composite: 82, kept: true }),
			makeIter({ iteration: 3, composite: 83, kept: true }),
		];
		assert.strictEqual(isPlateaued(state), true);
	});

	it("returns false when improvement exceeds 3pts", () => {
		const state = createState();
		state.currentBranch = null;
		state.iterations = [
			makeIter({ iteration: 0, composite: 50, kept: true }),
			makeIter({ iteration: 1, composite: 55, kept: true }),
			makeIter({ iteration: 2, composite: 60, kept: true }),
			makeIter({ iteration: 3, composite: 65, kept: true }),
		];
		assert.strictEqual(isPlateaued(state), false);
	});
});

// ---------------------------------------------------------------------------
// Task score history, stuck detection, variance
// ---------------------------------------------------------------------------

function makeTaskScore(overrides: Partial<TaskScoreEntry> = {}): TaskScoreEntry {
	return {
		iteration: 0,
		taskNumber: 1,
		taskName: "Test Task",
		tier: "P0",
		score: 50,
		stuckPoints: [],
		branch: "main",
		...overrides,
	};
}

describe("appendTaskScores + reconstructState roundtrip", () => {
	it("persists and reconstructs task scores", () => {
		const state = createState();
		state.active = true;
		state.mode = "quick";
		state.experimentName = "test";
		writeConfig(tmpDir, state);

		const entries = [
			makeTaskScore({ iteration: 0, taskNumber: 1, score: 50 }),
			makeTaskScore({ iteration: 0, taskNumber: 2, score: 80 }),
			makeTaskScore({ iteration: 1, taskNumber: 1, score: 60 }),
		];
		appendTaskScores(tmpDir, entries);

		const restored = reconstructState(tmpDir);
		assert.strictEqual(restored.taskScores.length, 3);
		assert.strictEqual(restored.taskScores[0].score, 50);
		assert.strictEqual(restored.taskScores[2].taskNumber, 1);
		assert.strictEqual(restored.taskScores[2].score, 60);
	});
});

describe("taskScoreHistory", () => {
	it("filters by task number and branch", () => {
		const state = createState();
		state.currentBranch = "proto-a";
		state.taskScores = [
			makeTaskScore({ taskNumber: 1, branch: "proto-a", score: 50 }),
			makeTaskScore({ taskNumber: 2, branch: "proto-a", score: 80 }),
			makeTaskScore({ taskNumber: 1, branch: "proto-b", score: 30 }),
			makeTaskScore({ taskNumber: 1, branch: "proto-a", score: 60, iteration: 1 }),
		];
		const history = taskScoreHistory(state, 1);
		assert.strictEqual(history.length, 2);
		assert.strictEqual(history[0].score, 50);
		assert.strictEqual(history[1].score, 60);
	});
});

describe("detectStuckTasks", () => {
	it("detects task with 3 consecutive zero scores and step-limit stuck", () => {
		const state = createState();
		state.currentBranch = "main";
		state.iterations = [
			makeIter({ iteration: 0, kept: true }),
			makeIter({ iteration: 1, kept: true }),
			makeIter({ iteration: 2, kept: true }),
		];
		state.taskScores = [
			makeTaskScore({ iteration: 0, taskNumber: 6, score: 0, stuckPoints: ["Reached maximum step limit"] }),
			makeTaskScore({ iteration: 1, taskNumber: 6, score: 0, stuckPoints: ["Reached maximum step limit"] }),
			makeTaskScore({ iteration: 2, taskNumber: 6, score: 0, stuckPoints: ["Reached maximum step limit"], taskName: "Near miss" }),
		];
		const stuck = detectStuckTasks(state);
		assert.strictEqual(stuck.length, 1);
		assert.strictEqual(stuck[0].taskNumber, 6);
		assert.strictEqual(stuck[0].consecutiveZeros, 3);
	});

	it("does not flag tasks that scored non-zero in latest iteration", () => {
		const state = createState();
		state.currentBranch = "main";
		state.iterations = [
			makeIter({ iteration: 0, kept: true }),
			makeIter({ iteration: 1, kept: true }),
			makeIter({ iteration: 2, kept: true }),
		];
		state.taskScores = [
			makeTaskScore({ iteration: 0, taskNumber: 6, score: 0, stuckPoints: ["Reached maximum step limit"] }),
			makeTaskScore({ iteration: 1, taskNumber: 6, score: 0, stuckPoints: ["Reached maximum step limit"] }),
			makeTaskScore({ iteration: 2, taskNumber: 6, score: 50, stuckPoints: [] }),
		];
		const stuck = detectStuckTasks(state);
		assert.strictEqual(stuck.length, 0);
	});

	it("only counts kept iterations", () => {
		const state = createState();
		state.currentBranch = "main";
		state.iterations = [
			makeIter({ iteration: 0, kept: true }),
			makeIter({ iteration: 1, kept: false }),
			makeIter({ iteration: 2, kept: true }),
			makeIter({ iteration: 3, kept: true }),
		];
		state.taskScores = [
			makeTaskScore({ iteration: 0, taskNumber: 6, score: 0, stuckPoints: ["Reached maximum step limit"] }),
			makeTaskScore({ iteration: 1, taskNumber: 6, score: 0, stuckPoints: ["Reached maximum step limit"] }),
			makeTaskScore({ iteration: 2, taskNumber: 6, score: 0, stuckPoints: ["Reached maximum step limit"] }),
			makeTaskScore({ iteration: 3, taskNumber: 6, score: 0, stuckPoints: ["Reached maximum step limit"] }),
		];
		// Only iters 0, 2, 3 are kept — 3 consecutive zeros
		const stuck = detectStuckTasks(state);
		assert.strictEqual(stuck.length, 1);
		assert.strictEqual(stuck[0].consecutiveZeros, 3);
	});

	it("does not flag task with zeros but no step-limit stuck", () => {
		const state = createState();
		state.currentBranch = "main";
		state.iterations = [
			makeIter({ iteration: 0, kept: true }),
			makeIter({ iteration: 1, kept: true }),
			makeIter({ iteration: 2, kept: true }),
		];
		state.taskScores = [
			makeTaskScore({ iteration: 0, taskNumber: 6, score: 0, stuckPoints: ["Element not found"] }),
			makeTaskScore({ iteration: 1, taskNumber: 6, score: 0, stuckPoints: ["Could not click button"] }),
			makeTaskScore({ iteration: 2, taskNumber: 6, score: 0, stuckPoints: ["Error in app"] }),
		];
		const stuck = detectStuckTasks(state);
		assert.strictEqual(stuck.length, 0);
	});
});

describe("taskScoreStats", () => {
	it("computes mean, stdev, min, max", () => {
		const state = createState();
		state.currentBranch = null;
		state.taskScores = [
			makeTaskScore({ taskNumber: 1, score: 25 }),
			makeTaskScore({ taskNumber: 1, score: 50, iteration: 1 }),
			makeTaskScore({ taskNumber: 1, score: 62, iteration: 2 }),
			makeTaskScore({ taskNumber: 1, score: 55, iteration: 3 }),
		];
		const stats = taskScoreStats(state, 1);
		assert.ok(stats !== null);
		assert.strictEqual(stats!.min, 25);
		assert.strictEqual(stats!.max, 62);
		assert.strictEqual(stats!.count, 4);
		// mean = 48, stdev ≈ 13.7
		assert.strictEqual(stats!.mean, 48);
		assert.ok(stats!.stdev > 13 && stats!.stdev < 14);
	});

	it("returns null with fewer than 2 data points", () => {
		const state = createState();
		state.currentBranch = null;
		state.taskScores = [makeTaskScore({ taskNumber: 1, score: 50 })];
		assert.strictEqual(taskScoreStats(state, 1), null);
	});

	it("returns null for nonexistent task", () => {
		const state = createState();
		state.currentBranch = null;
		state.taskScores = [makeTaskScore({ taskNumber: 1, score: 50 })];
		assert.strictEqual(taskScoreStats(state, 99), null);
	});
});

describe("compositeScoreStats", () => {
	it("computes composite stdev across iterations", () => {
		const state = createState();
		state.currentBranch = null;
		state.iterations = [
			makeIter({ iteration: 0, composite: 50 }),
			makeIter({ iteration: 1, composite: 60 }),
			makeIter({ iteration: 2, composite: 55 }),
		];
		const stats = compositeScoreStats(state);
		assert.ok(stats !== null);
		assert.strictEqual(stats!.count, 3);
		assert.strictEqual(stats!.mean, 55);
		assert.ok(stats!.stdev > 0);
	});

	it("returns null with fewer than 3 iterations", () => {
		const state = createState();
		state.currentBranch = null;
		state.iterations = [
			makeIter({ iteration: 0, composite: 50 }),
			makeIter({ iteration: 1, composite: 60 }),
		];
		assert.strictEqual(compositeScoreStats(state), null);
	});
});

describe("blockedTasks persistence", () => {
	it("persists and reconstructs blockedTasks via config", () => {
		const state = createState();
		state.active = true;
		state.mode = "quick";
		state.experimentName = "test";
		state.blockedTasks = [6, 8];
		writeConfig(tmpDir, state);

		const restored = reconstructState(tmpDir);
		assert.deepStrictEqual(restored.blockedTasks, [6, 8]);
	});

	it("defaults to empty array when not set", () => {
		const state = createState();
		state.active = true;
		state.experimentName = "test";
		writeConfig(tmpDir, state);

		const restored = reconstructState(tmpDir);
		assert.deepStrictEqual(restored.blockedTasks, []);
	});
});
