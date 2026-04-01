/**
 * T3: Evaluation logic tests (evaluate-logic.ts)
 *
 * Tests score computation, result merging, file reading, and timeout calculation.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	recomputeScores, mergeTaskResult, readEvalResults, computeTaskTimeoutMs,
	DEFAULT_MAX_STEPS, QUICK_MAX_STEPS, MAX_TASK_TIMEOUT_MS, TIMEOUT_PER_STEP_MS, TASK_OVERHEAD_MS,
	type EvalResultsJson, type TaskResultJson,
} from "../extensions/pi-autocrit/evaluate-logic.js";

let tmpDir: string;

beforeEach(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "autocrit-eval-test-"));
});

afterEach(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTask(overrides: Partial<TaskResultJson> = {}): TaskResultJson {
	return {
		number: 1,
		name: "Test Task",
		tier: "P0",
		completed: true,
		score: 100,
		steps: 3,
		stuck_points: [],
		found_answer: "answer",
		notes: "ok",
		persona_feedback: "great",
		wishlist: [],
		...overrides,
	};
}

function makeResults(tasks: TaskResultJson[]): EvalResultsJson {
	return {
		composite_score: 0,
		p0_score: 0,
		p1_score: 0,
		p2_score: 0,
		tasks,
	};
}

// ── recomputeScores ─────────────────────────────────────────────────────

describe("recomputeScores", () => {
	it("computes weighted average with all tiers present", () => {
		const results = makeResults([
			makeTask({ number: 1, tier: "P0", score: 90 }),
			makeTask({ number: 2, tier: "P1", score: 60 }),
			makeTask({ number: 3, tier: "P2", score: 40 }),
		]);

		recomputeScores(results);

		// 90*0.60 + 60*0.25 + 40*0.15 = 54 + 15 + 6 = 75.0
		assert.strictEqual(results.composite_score, 75);
		assert.strictEqual(results.p0_score, 90);
		assert.strictEqual(results.p1_score, 60);
		assert.strictEqual(results.p2_score, 40);
	});

	it("applies P0 zero cap (composite ≤ 40)", () => {
		const results = makeResults([
			makeTask({ number: 1, tier: "P0", score: 100 }),
			makeTask({ number: 2, tier: "P0", score: 0 }),
			makeTask({ number: 3, tier: "P1", score: 100 }),
			makeTask({ number: 4, tier: "P2", score: 100 }),
		]);

		recomputeScores(results);

		// P0 avg = 50, uncapped = 50*0.60 + 100*0.25 + 100*0.15 = 70
		// But any P0 = 0 → cap at 40
		assert.strictEqual(results.composite_score, 40);
	});

	it("handles only P0 tasks (missing tiers treated as 0)", () => {
		const results = makeResults([
			makeTask({ number: 1, tier: "P0", score: 80 }),
			makeTask({ number: 2, tier: "P0", score: 60 }),
		]);

		recomputeScores(results);

		// P0 avg = 70, P1 = 0, P2 = 0 → 70*0.60 = 42.0
		assert.strictEqual(results.composite_score, 42);
		assert.strictEqual(results.p0_score, 70);
		assert.strictEqual(results.p1_score, 0);
		assert.strictEqual(results.p2_score, 0);
	});

	it("rounds to 1 decimal", () => {
		const results = makeResults([
			makeTask({ number: 1, tier: "P0", score: 33.3 }),
			makeTask({ number: 2, tier: "P0", score: 66.7 }),
			makeTask({ number: 3, tier: "P1", score: 55.5 }),
			makeTask({ number: 4, tier: "P2", score: 44.4 }),
		]);

		recomputeScores(results);

		// P0 avg = 50.0, P1 = 55.5, P2 = 44.4
		// 50.0*0.60 + 55.5*0.25 + 44.4*0.15 = 30.0 + 13.875 + 6.66 = 50.535
		assert.strictEqual(results.composite_score, 50.5);
	});

	it("handles empty tasks array", () => {
		const results = makeResults([]);

		recomputeScores(results);

		assert.strictEqual(results.composite_score, 0);
		assert.strictEqual(results.p0_score, 0);
		assert.strictEqual(results.p1_score, 0);
		assert.strictEqual(results.p2_score, 0);
	});

	it("does not apply P0 cap when all P0 scores are non-zero", () => {
		const results = makeResults([
			makeTask({ number: 1, tier: "P0", score: 50 }),
			makeTask({ number: 2, tier: "P1", score: 100 }),
			makeTask({ number: 3, tier: "P2", score: 100 }),
		]);

		recomputeScores(results);

		// 50*0.60 + 100*0.25 + 100*0.15 = 30 + 25 + 15 = 70.0
		assert.strictEqual(results.composite_score, 70);
	});

	it("excludes blocked tasks from scoring", () => {
		const results = makeResults([
			makeTask({ number: 1, tier: "P0", score: 90 }),
			makeTask({ number: 2, tier: "P0", score: 0 }),  // blocked
			makeTask({ number: 3, tier: "P1", score: 60 }),
			makeTask({ number: 4, tier: "P2", score: 40 }),
		]);

		recomputeScores(results, [2]);

		// With task 2 blocked: P0 avg = 90 (only task 1), P1 = 60, P2 = 40
		// 90*0.60 + 60*0.25 + 40*0.15 = 54 + 15 + 6 = 75.0
		// No P0 zero cap since task 2 is excluded
		assert.strictEqual(results.composite_score, 75);
		assert.strictEqual(results.p0_score, 90);
	});

	it("blocked tasks: P0 zero cap only considers non-blocked tasks", () => {
		const results = makeResults([
			makeTask({ number: 1, tier: "P0", score: 0 }),  // blocked
			makeTask({ number: 2, tier: "P0", score: 80 }),  // not blocked
			makeTask({ number: 3, tier: "P1", score: 100 }),
			makeTask({ number: 4, tier: "P2", score: 100 }),
		]);

		recomputeScores(results, [1]);

		// Task 1 excluded. P0 avg = 80, P1 = 100, P2 = 100
		// 80*0.60 + 100*0.25 + 100*0.15 = 48 + 25 + 15 = 88.0
		// No zero cap since the only P0 zero (task 1) is blocked
		assert.strictEqual(results.composite_score, 88);
	});
});

// ── mergeTaskResult ─────────────────────────────────────────────────────

describe("mergeTaskResult", () => {
	it("adds new task to empty combined", () => {
		const combined = makeResults([]);
		const single = makeResults([makeTask({ number: 1, score: 85 })]);

		mergeTaskResult(combined, single);

		assert.strictEqual(combined.tasks.length, 1);
		assert.strictEqual(combined.tasks[0].number, 1);
		assert.strictEqual(combined.tasks[0].score, 85);
	});

	it("updates existing task by number", () => {
		const combined = makeResults([makeTask({ number: 1, score: 50 })]);
		const single = makeResults([makeTask({ number: 1, score: 90 })]);

		mergeTaskResult(combined, single);

		assert.strictEqual(combined.tasks.length, 1);
		assert.strictEqual(combined.tasks[0].score, 90);
	});

	it("sorts tasks by number after merge", () => {
		const combined = makeResults([makeTask({ number: 3, score: 30 })]);
		const single = makeResults([makeTask({ number: 1, score: 10 })]);

		mergeTaskResult(combined, single);

		assert.strictEqual(combined.tasks.length, 2);
		assert.strictEqual(combined.tasks[0].number, 1);
		assert.strictEqual(combined.tasks[1].number, 3);
	});

	it("handles multiple tasks in single merge", () => {
		const combined = makeResults([makeTask({ number: 1, score: 50 })]);
		const single = makeResults([
			makeTask({ number: 2, score: 70 }),
			makeTask({ number: 3, score: 80 }),
		]);

		mergeTaskResult(combined, single);

		assert.strictEqual(combined.tasks.length, 3);
		assert.deepStrictEqual(
			combined.tasks.map((t) => t.number),
			[1, 2, 3],
		);
	});
});

// ── readEvalResults ─────────────────────────────────────────────────────

describe("readEvalResults", () => {
	it("reads valid JSON file", () => {
		const filePath = path.join(tmpDir, "eval_results.json");
		const data = makeResults([makeTask({ number: 1, score: 85 })]);
		data.composite_score = 85;
		fs.writeFileSync(filePath, JSON.stringify(data));

		const result = readEvalResults(filePath);
		assert.ok(result !== null);
		assert.strictEqual(result!.composite_score, 85);
		assert.strictEqual(result!.tasks.length, 1);
	});

	it("returns null for missing file", () => {
		const result = readEvalResults(path.join(tmpDir, "nonexistent.json"));
		assert.strictEqual(result, null);
	});

	it("returns null for corrupted JSON", () => {
		const filePath = path.join(tmpDir, "eval_results.json");
		fs.writeFileSync(filePath, "this is not { json at all");

		const result = readEvalResults(filePath);
		assert.strictEqual(result, null);
	});
});

// ── computeTaskTimeoutMs ────────────────────────────────────────────────

describe("computeTaskTimeoutMs", () => {
	it("scales by steps × runs", () => {
		const timeout = computeTaskTimeoutMs(10, 1);
		// (10 * 60000 + 60000) * 1 = 660000 ms = 11 min
		assert.strictEqual(timeout, (10 * TIMEOUT_PER_STEP_MS + TASK_OVERHEAD_MS) * 1);
	});

	it("respects MAX_TASK_TIMEOUT_MS cap", () => {
		// With huge values, should cap
		const timeout = computeTaskTimeoutMs(1000, 10);
		assert.strictEqual(timeout, MAX_TASK_TIMEOUT_MS);
	});

	it("quick mode (10 steps, 1 run)", () => {
		const timeout = computeTaskTimeoutMs(QUICK_MAX_STEPS, 1);
		// (10 * 60000 + 60000) * 1 = 660000
		const expected = (QUICK_MAX_STEPS * TIMEOUT_PER_STEP_MS + TASK_OVERHEAD_MS) * 1;
		assert.strictEqual(timeout, expected);
		assert.ok(timeout < MAX_TASK_TIMEOUT_MS);
	});

	it("full mode (15 steps, 2 runs)", () => {
		const timeout = computeTaskTimeoutMs(DEFAULT_MAX_STEPS, 2);
		// (15 * 60000 + 60000) * 2 = 1920000
		const expected = (DEFAULT_MAX_STEPS * TIMEOUT_PER_STEP_MS + TASK_OVERHEAD_MS) * 2;
		assert.strictEqual(timeout, Math.min(expected, MAX_TASK_TIMEOUT_MS));
	});
});
