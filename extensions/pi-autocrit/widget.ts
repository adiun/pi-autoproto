/**
 * Dashboard widget rendering for pi-autocrit.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { AutocritState, IterationResult } from "./state.js";
import { currentBranchIterations, bestIteration } from "./state.js";

// ---------------------------------------------------------------------------
// Compact one-liner widget
// ---------------------------------------------------------------------------

export function renderCompactWidget(state: AutocritState, theme: Theme): Text {
	const iters = currentBranchIterations(state);
	const best = bestIteration(state);
	const latest = iters.length > 0 ? iters[iters.length - 1] : null;

	const parts: string[] = [];
	parts.push(theme.fg("accent", "🎯"));

	if (state.experimentName) {
		parts.push(theme.fg("dim", ` ${state.experimentName}`));
	}

	if (latest) {
		parts.push(theme.fg("muted", ` iter ${latest.iteration}`));
		parts.push(theme.fg("dim", " │ "));
		parts.push(
			theme.fg("warning", theme.bold(`composite: ${latest.composite.toFixed(1)}`)),
		);
		parts.push(
			theme.fg("muted", ` (P0: ${latest.p0.toFixed(1)} P1: ${latest.p1.toFixed(1)} P2: ${latest.p2.toFixed(1)})`),
		);

		// Delta from previous
		if (iters.length > 1) {
			const prev = iters[iters.length - 2];
			const delta = latest.composite - prev.composite;
			if (delta > 0) {
				parts.push(theme.fg("success", ` ▲+${delta.toFixed(1)}`));
			} else if (delta < 0) {
				parts.push(theme.fg("error", ` ▼${delta.toFixed(1)}`));
			}
			parts.push(theme.fg("dim", ` from iter ${prev.iteration}`));
		}
	} else {
		parts.push(theme.fg("muted", " no iterations yet"));
	}

	if (state.currentBranch) {
		parts.push(theme.fg("dim", ` │ ${state.currentBranch}`));
	}

	parts.push(theme.fg("dim", "  (ctrl+x expand)"));

	return new Text(parts.join(""), 0, 0);
}

// ---------------------------------------------------------------------------
// Expanded dashboard table
// ---------------------------------------------------------------------------

export function renderExpandedWidget(state: AutocritState, theme: Theme): Text {
	const width = process.stdout.columns || 120;
	const lines: string[] = [];

	// Header bar
	const label = `🎯 autocrit${state.experimentName ? `: ${state.experimentName}` : ""}`;
	const hint = " ctrl+x collapse ";
	const fillLen = Math.max(0, width - 3 - 1 - label.length - 1 - hint.length);
	lines.push(
		truncateToWidth(
			theme.fg("borderMuted", "───") +
				theme.fg("accent", ` ${label} `) +
				theme.fg("borderMuted", "─".repeat(fillLen)) +
				theme.fg("dim", hint),
			width,
		),
	);

	// Mode + branch info
	const modeStr = state.mode === "full" ? "full" : "quick";
	const branchStr = state.currentBranch ?? "—";
	const iters = currentBranchIterations(state);
	const iterStr = iters.length > 0 ? `${iters.length}` : "0";
	lines.push(
		truncateToWidth(
			`  ${theme.fg("muted", "Mode:")} ${theme.fg("text", modeStr)}` +
				`  │  ${theme.fg("muted", "Branch:")} ${theme.fg("accent", branchStr)}` +
				`  │  ${theme.fg("muted", "Iterations:")} ${theme.fg("text", iterStr)}`,
			width,
		),
	);
	lines.push("");

	if (iters.length === 0) {
		lines.push(`  ${theme.fg("dim", "No iterations yet.")}`);
		return new Text(lines.join("\n"), 0, 0);
	}

	// Table header
	const col = { idx: 4, iter: 6, composite: 12, p0: 8, p1: 8, p2: 8, status: 12 };
	const fixedW = col.idx + col.iter + col.composite + col.p0 + col.p1 + col.p2 + col.status + 4;
	const descW = Math.max(10, width - fixedW);

	lines.push(
		truncateToWidth(
			`  ${theme.fg("muted", "#".padEnd(col.idx))}` +
				`${theme.fg("muted", "iter".padEnd(col.iter))}` +
				`${theme.fg("warning", theme.bold("composite".padEnd(col.composite)))}` +
				`${theme.fg("muted", "P0".padEnd(col.p0))}` +
				`${theme.fg("muted", "P1".padEnd(col.p1))}` +
				`${theme.fg("muted", "P2".padEnd(col.p2))}` +
				`${theme.fg("muted", "status".padEnd(col.status))}` +
				`${theme.fg("muted", "description")}`,
			width,
		),
	);
	lines.push(truncateToWidth(`  ${theme.fg("borderMuted", "─".repeat(width - 4))}`, width));

	// Show last 8 rows
	const maxRows = 8;
	const startIdx = Math.max(0, iters.length - maxRows);
	if (startIdx > 0) {
		lines.push(truncateToWidth(`  ${theme.fg("dim", `… ${startIdx} earlier iteration${startIdx === 1 ? "" : "s"}`)}`, width));
	}

	for (let i = startIdx; i < iters.length; i++) {
		const r = iters[i];
		const statusColor = r.kept ? "success" : "warning";
		const statusStr = r.kept ? "kept" : "discarded";

		// Color composite based on improvement
		let compColor: Parameters<typeof theme.fg>[0] = "text";
		if (i > 0) {
			const baseline = iters[0].composite;
			compColor = r.composite > baseline ? "success" : r.composite < baseline ? "error" : "text";
		}

		lines.push(
			truncateToWidth(
				`  ${theme.fg("dim", String(i + 1).padEnd(col.idx))}` +
					`${theme.fg("text", String(r.iteration).padEnd(col.iter))}` +
					`${theme.fg(compColor, theme.bold(r.composite.toFixed(1).padEnd(col.composite)))}` +
					`${theme.fg("muted", r.p0.toFixed(1).padEnd(col.p0))}` +
					`${theme.fg("muted", r.p1.toFixed(1).padEnd(col.p1))}` +
					`${theme.fg("muted", r.p2.toFixed(1).padEnd(col.p2))}` +
					`${theme.fg(statusColor, statusStr.padEnd(col.status))}` +
					`${theme.fg("muted", r.description.slice(0, descW))}`,
				width,
			),
		);
	}

	return new Text(lines.join("\n"), 0, 0);
}
