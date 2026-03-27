/**
 * T4 + T5: Tool parameter schema validation (Plan 3 regression tests)
 *
 * Verifies that run_evaluation and log_iteration have exactly the parameters
 * defined in Plan 3 — no more, no less. This prevents accidental reintroduction
 * of removed parameters.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { createMockPi, type MockPi } from "./mock-pi.js";
import { createRuntime, type AutocritRuntime } from "../extensions/pi-autocrit/state.js";
import { registerEvaluateTool } from "../extensions/pi-autocrit/tools/evaluate.js";
import { registerLogTool } from "../extensions/pi-autocrit/tools/log.js";

let mock: MockPi;
let runtime: AutocritRuntime;

beforeEach(() => {
	mock = createMockPi();
	runtime = createRuntime();
	const getRuntime = () => runtime;
	registerEvaluateTool(mock.pi as any, getRuntime);
	registerLogTool(mock.pi as any, getRuntime);
});

// ── T4: run_evaluation schema ───────────────────────────────────────────

describe("run_evaluation schema (Plan 3)", () => {
	it("has exactly 4 properties: iteration, mode, task, variant_count", () => {
		const props = mock.getSchemaProperties("run_evaluation");
		assert.ok(props, "run_evaluation should be registered");
		const keys = Object.keys(props!);
		assert.deepStrictEqual(keys.sort(), ["iteration", "mode", "task", "variant_count"].sort());
	});

	it("mode enum is exactly ['quick', 'full', 'variants']", () => {
		const props = mock.getSchemaProperties("run_evaluation")!;
		const modeSchema = props.mode as Record<string, unknown>;
		// StringEnum wraps as anyOf or enum depending on typebox version
		const enumValues = extractEnumValues(modeSchema);
		assert.deepStrictEqual(enumValues.sort(), ["full", "quick", "variants"]);
	});

	it("no tier property", () => {
		const props = mock.getSchemaProperties("run_evaluation")!;
		assert.strictEqual("tier" in props, false, "tier should be removed");
	});

	it("no runs property", () => {
		const props = mock.getSchemaProperties("run_evaluation")!;
		assert.strictEqual("runs" in props, false, "runs should be removed");
	});

	it("no max_steps property", () => {
		const props = mock.getSchemaProperties("run_evaluation")!;
		assert.strictEqual("max_steps" in props, false, "max_steps should be removed");
	});

	it("no skip_feedback property", () => {
		const props = mock.getSchemaProperties("run_evaluation")!;
		assert.strictEqual("skip_feedback" in props, false, "skip_feedback should be removed");
	});

	it("no requirements_file property", () => {
		const props = mock.getSchemaProperties("run_evaluation")!;
		assert.strictEqual("requirements_file" in props, false, "requirements_file should be removed");
	});
});

// ── T5: log_iteration schema ────────────────────────────────────────────

describe("log_iteration schema (Plan 3)", () => {
	it("has exactly 7 properties", () => {
		const props = mock.getSchemaProperties("log_iteration");
		assert.ok(props, "log_iteration should be registered");
		const keys = Object.keys(props!);
		assert.strictEqual(keys.length, 7, `Expected 7 properties, got ${keys.length}: ${keys.join(", ")}`);
	});

	it("has the expected properties", () => {
		const props = mock.getSchemaProperties("log_iteration")!;
		const keys = Object.keys(props);
		const expected = ["iteration", "composite", "p0", "p1", "p2", "description", "kept"];
		assert.deepStrictEqual(keys.sort(), expected.sort());
	});

	it("no dev_plan property", () => {
		const props = mock.getSchemaProperties("log_iteration")!;
		assert.strictEqual("dev_plan" in props, false, "dev_plan should be removed");
	});
});

// ── Helper ──────────────────────────────────────────────────────────────

/**
 * Extract enum values from a Typebox schema.
 * Handles both `anyOf: [{const: "a"}, ...]` and `enum: ["a", ...]` patterns.
 */
function extractEnumValues(schema: Record<string, unknown>): string[] {
	if (Array.isArray(schema.anyOf)) {
		return (schema.anyOf as Array<Record<string, unknown>>).map((s) => s.const as string);
	}
	if (Array.isArray(schema.enum)) {
		return schema.enum as string[];
	}
	// Typebox Optional wraps in another layer
	if (schema.anyOf === undefined && schema.properties) {
		// Shouldn't happen for mode, but handle it
	}
	// Try to find it in nested structures
	const inner = Object.values(schema).find((v) =>
		typeof v === "object" && v !== null && ("anyOf" in (v as Record<string, unknown>) || "enum" in (v as Record<string, unknown>)),
	);
	if (inner) {
		return extractEnumValues(inner as Record<string, unknown>);
	}
	return [];
}
