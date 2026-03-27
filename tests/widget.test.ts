/**
 * T7: Widget rendering tests (widget.ts)
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { renderCompactWidget, renderExpandedWidget } from "../extensions/pi-autocrit/widget.js";
import { createState, type AutocritState, type IterationResult } from "../extensions/pi-autocrit/state.js";
import { createMockTheme } from "./mock-pi.js";

const theme = createMockTheme();

function makeState(iters: Partial<IterationResult>[]): AutocritState {
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
});

describe("renderExpandedWidget", () => {
	it("shows table header", () => {
		const state = makeState([
			{ composite: 72.5 },
		]);
		const widget = renderExpandedWidget(state, theme as any);
		const text = widget.text;
		assert.ok(text.includes("composite"), `Expected 'composite' header in: ${text}`);
		assert.ok(text.includes("P0"), `Expected P0 header in: ${text}`);
		assert.ok(text.includes("P1"), `Expected P1 header in: ${text}`);
	});

	it("shows last 8 iterations when more than 8", () => {
		const iters = Array.from({ length: 12 }, (_, i) => ({
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
		assert.ok(text.includes("iter 11"), `Expected iter 11 in: ${text}`);
	});

	it("does not show 'earlier' message when 8 or fewer iterations", () => {
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
});
