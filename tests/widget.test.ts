/**
 * T7: Widget rendering tests (widget.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { renderCompactWidget, renderExpandedWidget, renderFullscreenWidget, type IterationFeedbackData } from "../extensions/pi-autoproto/widget.js";
import { createState, type AutoprotoState, type IterationResult } from "../extensions/pi-autoproto/state.js";
import { createMockTheme } from "./mock-pi.js";

const theme = createMockTheme();

function makeState(iters: Partial<IterationResult>[]): AutoprotoState {
	const state = createState();
	state.active = true;
	state.experimentName = "test-exp";
	state.currentBranch = "main";
	state.iterations = iters.map((overrides, i) => ({
		iteration: i,
		composite: 50,
		p0: 60,
		p1: 40,
		p2: 30,
		description: `iteration ${i}`,
		kept: true,
		branch: "main",
		timestamp: Date.now() + i,
		...overrides,
	}));
	return state;
}

describe("renderCompactWidget", () => {
	it("shows 'no iterations yet' when empty", () => {
		const state = makeState([]);
		const widget = renderCompactWidget(state, theme as any);
		const text = widget.text;
		assert.ok(text.includes("no iterations yet"), `Expected placeholder in: ${text}`);
	});

	it("shows composite score with iterations", () => {
		const state = makeState([
			{ composite: 72.5 },
		]);
		const widget = renderCompactWidget(state, theme as any);
		const text = widget.text;
		assert.ok(text.includes("72.5"), `Expected composite 72.5 in: ${text}`);
	});

	it("shows delta from previous iteration", () => {
		const state = makeState([
			{ iteration: 0, composite: 50 },
			{ iteration: 1, composite: 65 },
		]);
		const widget = renderCompactWidget(state, theme as any);
		const text = widget.text;
		assert.ok(text.includes("15.0"), `Expected delta 15.0 in: ${text}`);
		assert.ok(text.includes("▲"), `Expected upward arrow in: ${text}`);
	});

	it("shows negative delta", () => {
		const state = makeState([
			{ iteration: 0, composite: 80 },
			{ iteration: 1, composite: 70 },
		]);
		const widget = renderCompactWidget(state, theme as any);
		const text = widget.text;
		assert.ok(text.includes("▼"), `Expected downward arrow in: ${text}`);
	});

	it("shows elapsed time when startTime is set", () => {
		const state = makeState([{ composite: 50 }]);
		state.startTime = Date.now() - 754_000; // 12m 34s
		const widget = renderCompactWidget(state, theme as any);
		const text = widget.text;
		assert.ok(text.includes("⏱"), `Expected timer icon in: ${text}`);
		assert.ok(text.includes("12m"), `Expected '12m' in: ${text}`);
	});

	it("does not show timer when startTime is null", () => {
		const state = makeState([{ composite: 50 }]);
		state.startTime = null;
		const widget = renderCompactWidget(state, theme as any);
		const text = widget.text;
		assert.ok(!text.includes("⏱"), `Should not have timer icon in: ${text}`);
	});
});

describe("renderExpandedWidget", () => {
	it("shows table header with delta column", () => {
		const state = makeState([
			{ composite: 72.5 },
		]);
		const widget = renderExpandedWidget(state, theme as any);
		const text = widget.text;
		assert.ok(text.includes("composite"), `Expected 'composite' header in: ${text}`);
		assert.ok(text.includes("P0"), `Expected P0 header in: ${text}`);
		assert.ok(text.includes("P1"), `Expected P1 header in: ${text}`);
		assert.ok(text.includes("delta"), `Expected 'delta' header in: ${text}`);
	});

	it("shows last 10 iterations when more than 10", () => {
		const iters = Array.from({ length: 14 }, (_, i) => ({
			iteration: i,
			composite: 50 + i,
			description: `iter ${i}`,
		}));
		const state = makeState(iters);
		const widget = renderExpandedWidget(state, theme as any);
		const text = widget.text;
		// Should mention earlier iterations
		assert.ok(text.includes("earlier"), `Expected 'earlier iterations' message in: ${text}`);
		// Should show the last iteration
		assert.ok(text.includes("iter 13"), `Expected iter 13 in: ${text}`);
	});

	it("does not show 'earlier' message when 10 or fewer iterations", () => {
		const iters = Array.from({ length: 5 }, (_, i) => ({
			iteration: i,
			composite: 50 + i,
			description: `iter ${i}`,
		}));
		const state = makeState(iters);
		const widget = renderExpandedWidget(state, theme as any);
		const text = widget.text;
		assert.ok(!text.includes("earlier"), `Should not mention 'earlier' with only 5 iterations`);
	});

	it("shows elapsed time when startTime is set", () => {
		const state = makeState([{ composite: 50 }]);
		state.startTime = Date.now() - 3_600_000; // 1 hour
		const widget = renderExpandedWidget(state, theme as any);
		const text = widget.text;
		assert.ok(text.includes("⏱"), `Expected timer icon in: ${text}`);
		assert.ok(text.includes("1h"), `Expected '1h' in: ${text}`);
	});

	it("shows kept/discarded counts", () => {
		const state = makeState([
			{ iteration: 0, composite: 50, kept: true },
			{ iteration: 1, composite: 45, kept: false },
			{ iteration: 2, composite: 60, kept: true },
		]);
		const widget = renderExpandedWidget(state, theme as any);
		const text = widget.text;
		assert.ok(text.includes("2 kept"), `Expected '2 kept' in: ${text}`);
		assert.ok(text.includes("1 discarded"), `Expected '1 discarded' in: ${text}`);
	});

	it("shows best iteration with star marker", () => {
		const state = makeState([
			{ iteration: 0, composite: 50, kept: true },
			{ iteration: 1, composite: 80, kept: true },
			{ iteration: 2, composite: 70, kept: true },
		]);
		const widget = renderExpandedWidget(state, theme as any);
		const text = widget.text;
		assert.ok(text.includes("Best:"), `Expected 'Best:' in: ${text}`);
		assert.ok(text.includes("80.0"), `Expected best score 80.0 in: ${text}`);
		assert.ok(text.includes("★"), `Expected star marker in: ${text}`);
	});

	it("shows sparkline trend with enough data", () => {
		const state = makeState([
			{ iteration: 0, composite: 50, kept: true },
			{ iteration: 1, composite: 60, kept: true },
			{ iteration: 2, composite: 70, kept: true },
		]);
		const widget = renderExpandedWidget(state, theme as any);
		const text = widget.text;
		assert.ok(text.includes("Trend:"), `Expected 'Trend:' in: ${text}`);
	});

	it("shows net change in footer", () => {
		const state = makeState([
			{ iteration: 0, composite: 50, kept: true },
			{ iteration: 1, composite: 80, kept: true },
		]);
		const widget = renderExpandedWidget(state, theme as any);
		const text = widget.text;
		assert.ok(text.includes("Net change:"), `Expected 'Net change:' in: ${text}`);
		assert.ok(text.includes("+30.0"), `Expected '+30.0' net change in: ${text}`);
	});

	it("shows ctrl+x detail hint", () => {
		const state = makeState([{ composite: 50 }]);
		const widget = renderExpandedWidget(state, theme as any);
		const text = widget.text;
		assert.ok(text.includes("ctrl+x detail"), `Expected 'ctrl+x detail' hint in: ${text}`);
	});

	it("delta column does not run into status column", () => {
		const state = makeState([
			{ iteration: 0, composite: 50, kept: true },
			{ iteration: 1, composite: 54.4, kept: true },
		]);
		const widget = renderExpandedWidget(state, theme as any);
		const text = widget.text;
		// Delta "+4.4" and "kept" should NOT be adjacent (no "+4.4kept")
		assert.ok(!text.includes("+4.4kept"), `Delta and status should be in separate columns: ${text}`);
		// Both should appear in the output
		assert.ok(text.includes("+4.4"), `Expected delta '+4.4' in: ${text}`);
		assert.ok(text.includes("kept"), `Expected 'kept' status in: ${text}`);
	});

	it("negative delta column does not run into status column", () => {
		const state = makeState([
			{ iteration: 0, composite: 80, kept: true },
			{ iteration: 1, composite: 72.3, kept: false },
		]);
		const widget = renderExpandedWidget(state, theme as any);
		const text = widget.text;
		assert.ok(!text.includes("-7.7discarded"), `Delta and status should be in separate columns: ${text}`);
		assert.ok(text.includes("-7.7"), `Expected delta '-7.7' in: ${text}`);
		assert.ok(text.includes("discarded"), `Expected 'discarded' status in: ${text}`);
	});
});

describe("renderFullscreenWidget", () => {
	it("includes expanded content plus feedback section", () => {
		const state = makeState([{ iteration: 0, composite: 50, kept: true }]);
		const feedbackData: IterationFeedbackData[] = [{
			iteration: 0,
			tasks: [{
				number: 1,
				name: "Calculate tip",
				tier: "P0",
				completed: true,
				score: 85,
				persona_feedback: "The tip calculator was easy to use.",
				stuck_points: [],
				wishlist: ["Split bill feature"],
			}],
		}];
		const widget = renderFullscreenWidget(state, theme as any, feedbackData);
		const text = widget.text;
		// Should have expanded content
		assert.ok(text.includes("composite"), `Expected 'composite' header in: ${text}`);
		// Should have feedback section
		assert.ok(text.includes("Persona Feedback"), `Expected 'Persona Feedback' section in: ${text}`);
		assert.ok(text.includes("Calculate tip"), `Expected task name in: ${text}`);
		assert.ok(text.includes("The tip calculator was easy to use."), `Expected feedback text in: ${text}`);
		assert.ok(text.includes("Split bill feature"), `Expected wishlist item in: ${text}`);
	});

	it("shows ctrl+x collapse hint", () => {
		const state = makeState([{ composite: 50 }]);
		const widget = renderFullscreenWidget(state, theme as any, []);
		const text = widget.text;
		assert.ok(text.includes("ctrl+x collapse"), `Expected 'ctrl+x collapse' hint in: ${text}`);
	});

	it("shows placeholder when no feedback data", () => {
		const state = makeState([{ composite: 50 }]);
		const widget = renderFullscreenWidget(state, theme as any, []);
		const text = widget.text;
		assert.ok(text.includes("No evaluation feedback available"), `Expected placeholder in: ${text}`);
	});

	it("shows stuck points and wishlist", () => {
		const state = makeState([{ iteration: 0, composite: 30, kept: true }]);
		const feedbackData: IterationFeedbackData[] = [{
			iteration: 0,
			tasks: [{
				number: 1,
				name: "Find budget",
				tier: "P0",
				completed: false,
				score: 20,
				persona_feedback: "Couldn't find the budget section.",
				stuck_points: ["Clicked settings instead of dashboard"],
				wishlist: ["Clear navigation labels", "Budget shortcut on home"],
			}],
		}];
		const widget = renderFullscreenWidget(state, theme as any, feedbackData);
		const text = widget.text;
		assert.ok(text.includes("Stuck:"), `Expected 'Stuck:' label in: ${text}`);
		assert.ok(text.includes("Clicked settings instead of dashboard"), `Expected stuck point in: ${text}`);
		assert.ok(text.includes("Clear navigation labels"), `Expected wishlist item in: ${text}`);
		assert.ok(text.includes("Budget shortcut on home"), `Expected second wishlist item in: ${text}`);
	});

	it("shows feedback evolution across multiple iterations", () => {
		const state = makeState([
			{ iteration: 0, composite: 30, kept: true },
			{ iteration: 1, composite: 60, kept: true },
		]);
		const feedbackData: IterationFeedbackData[] = [
			{
				iteration: 0,
				tasks: [{
					number: 1, name: "Calculate tip", tier: "P0",
					completed: false, score: 20,
					persona_feedback: "Could not find the calculator.",
					stuck_points: [], wishlist: [],
				}],
			},
			{
				iteration: 1,
				tasks: [{
					number: 1, name: "Calculate tip", tier: "P0",
					completed: true, score: 85,
					persona_feedback: "Calculator works great now.",
					stuck_points: [], wishlist: [],
				}],
			},
		];
		const widget = renderFullscreenWidget(state, theme as any, feedbackData);
		const text = widget.text;
		// Both iterations' feedback should appear
		assert.ok(text.includes("Could not find the calculator."), `Expected iter 0 feedback in: ${text}`);
		assert.ok(text.includes("Calculator works great now."), `Expected iter 1 feedback in: ${text}`);
		// Latest status should be PASS
		assert.ok(text.includes("PASS"), `Expected PASS status in: ${text}`);
	});
});
