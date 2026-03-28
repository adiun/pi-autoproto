/**
 * Dashboard widget rendering for pi-autocrit.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { AutocritState, IterationResult } from "./state.js";
import { currentBranchIterations, bestIteration } from "./state.js";
import { formatDuration, getElapsedMs, sparkline } from "./utils.js";

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

	// Elapsed time
	const elapsed = getElapsedMs(state);
	if (elapsed > 0) {
		parts.push(theme.fg("dim", ` │ ⏱ ${formatDuration(elapsed)}`));
	}

	if (state.currentBranch) {
		parts.push(theme.fg("dim", ` │ ${state.currentBranch}`));
	}

	parts.push(theme.fg("dim", "  (ctrl+x expand)"));

	return new Text(parts.join(""), 0, 0);
}

// ---------------------------------------------------------------------------
// Expanded dashboard
// ---------------------------------------------------------------------------

export function renderExpandedWidget(state: AutocritState, theme: Theme): Text {
	const width = process.stdout.columns || 120;
	const lines: string[] = [];

	// ── Header bar ──────────────────────────────────────────────────────
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

	// ── Stats row ───────────────────────────────────────────────────────
	const iters = currentBranchIterations(state);
	const best = bestIteration(state);
	const keptCount = iters.filter((r) => r.kept).length;
	const discardedCount = iters.filter((r) => !r.kept).length;
	const modeStr = state.mode === "full" ? "full" : "quick";
	const branchStr = state.currentBranch ?? "—";

	const statsLeft =
		`  ${theme.fg("muted", "Mode:")} ${theme.fg("text", modeStr)}` +
		`  │  ${theme.fg("muted", "Branch:")} ${theme.fg("accent", branchStr)}` +
		`  │  ${theme.fg("muted", "Iterations:")} ${theme.fg("text", String(iters.length))}` +
		` (${theme.fg("success", `${keptCount} kept`)}` +
		(discardedCount > 0 ? `, ${theme.fg("warning", `${discardedCount} discarded`)}` : "") +
		`)`;

	const elapsed = getElapsedMs(state);
	const timeStr = elapsed > 0 ? `  │  ${theme.fg("muted", "⏱")} ${theme.fg("text", formatDuration(elapsed))}` : "";

	lines.push(truncateToWidth(statsLeft + timeStr, width));

	// ── Best score + sparkline row ──────────────────────────────────────
	if (iters.length > 0) {
		const bestStr = best
			? `${theme.fg("muted", "Best:")} ${theme.fg("success", theme.bold(best.composite.toFixed(1)))}` +
			  ` ${theme.fg("dim", `(iter ${best.iteration})`)}`
			: "";

		const keptIters = iters.filter((r) => r.kept);
		const sparkValues = keptIters.map((r) => r.composite);
		const sparkStr = sparkValues.length >= 2
			? `  │  ${theme.fg("muted", "Trend:")} ${theme.fg("accent", sparkline(sparkValues))}`
			: "";

		const latest = iters[iters.length - 1];
		const latestStr = latest
			? `  │  ${theme.fg("muted", "Latest:")} ${theme.fg("warning", latest.composite.toFixed(1))}` +
			  ` ${theme.fg("dim", `(iter ${latest.iteration})`)}`
			: "";

		lines.push(truncateToWidth(`  ${bestStr}${latestStr}${sparkStr}`, width));
	}

	lines.push("");

	if (iters.length === 0) {
		lines.push(`  ${theme.fg("dim", "No iterations yet — run run_evaluation to get started.")}`);
		lines.push("");
		return new Text(lines.join("\n"), 0, 0);
	}

	// ── Table header ────────────────────────────────────────────────────
	const col = { idx: 4, iter: 6, composite: 12, p0: 8, p1: 8, p2: 8, delta: 10, status: 12 };
	const fixedW = col.idx + col.iter + col.composite + col.p0 + col.p1 + col.p2 + col.delta + col.status + 4;
	const descW = Math.max(10, width - fixedW);

	lines.push(
		truncateToWidth(
			`  ${theme.fg("muted", "#".padEnd(col.idx))}` +
				`${theme.fg("muted", "iter".padEnd(col.iter))}` +
				`${theme.fg("warning", theme.bold("composite".padEnd(col.composite)))}` +
				`${theme.fg("muted", "P0".padEnd(col.p0))}` +
				`${theme.fg("muted", "P1".padEnd(col.p1))}` +
				`${theme.fg("muted", "P2".padEnd(col.p2))}` +
				`${theme.fg("muted", "delta".padEnd(col.delta))}` +
				`${theme.fg("muted", "status".padEnd(col.status))}` +
				`${theme.fg("muted", "description")}`,
			width,
		),
	);
	lines.push(truncateToWidth(`  ${theme.fg("borderMuted", "─".repeat(width - 4))}`, width));

	// ── Iteration rows ──────────────────────────────────────────────────
	const maxRows = 10;
	const startIdx = Math.max(0, iters.length - maxRows);
	if (startIdx > 0) {
		lines.push(truncateToWidth(`  ${theme.fg("dim", `… ${startIdx} earlier iteration${startIdx === 1 ? "" : "s"}`)}`, width));
	}

	for (let i = startIdx; i < iters.length; i++) {
		const r = iters[i];
		const statusColor = r.kept ? "success" : "warning";
		const statusStr = r.kept ? "kept" : "discarded";
		const isBest = best && r.iteration === best.iteration && r.kept;

		// Color composite based on improvement from first
		let compColor: Parameters<typeof theme.fg>[0] = "text";
		if (i > 0) {
			const baseline = iters[0].composite;
			compColor = r.composite > baseline ? "success" : r.composite < baseline ? "error" : "text";
		}

		// Delta column
		let deltaStr = "—".padEnd(col.delta);
		if (i > 0) {
			const prev = iters[i - 1];
			const delta = r.composite - prev.composite;
			if (delta > 0) {
				deltaStr = theme.fg("success", `+${delta.toFixed(1)}`).padEnd(col.delta);
			} else if (delta < 0) {
				deltaStr = theme.fg("error", delta.toFixed(1)).padEnd(col.delta);
			}
		}

		const bestMarker = isBest ? theme.fg("success", "★ ") : "  ";

		lines.push(
			truncateToWidth(
				bestMarker +
					`${theme.fg("dim", String(i + 1).padEnd(col.idx))}` +
					`${theme.fg("text", String(r.iteration).padEnd(col.iter))}` +
					`${theme.fg(compColor, theme.bold(r.composite.toFixed(1).padEnd(col.composite)))}` +
					`${theme.fg("muted", r.p0.toFixed(1).padEnd(col.p0))}` +
					`${theme.fg("muted", r.p1.toFixed(1).padEnd(col.p1))}` +
					`${theme.fg("muted", r.p2.toFixed(1).padEnd(col.p2))}` +
					deltaStr +
					`${theme.fg(statusColor, statusStr.padEnd(col.status))}` +
					`${theme.fg("muted", r.description.slice(0, descW))}`,
				width,
			),
		);
	}

	// ── Footer ──────────────────────────────────────────────────────────
	lines.push(truncateToWidth(`  ${theme.fg("borderMuted", "─".repeat(width - 4))}`, width));

	// Net change from first kept to best
	const keptIters = iters.filter((r) => r.kept);
	if (keptIters.length >= 2 && best) {
		const first = keptIters[0];
		const netDelta = best.composite - first.composite;
		const sign = netDelta >= 0 ? "+" : "";
		const netColor: Parameters<typeof theme.fg>[0] = netDelta > 0 ? "success" : netDelta < 0 ? "error" : "muted";
		lines.push(
			truncateToWidth(
				`  ${theme.fg("muted", "Net change:")} ${theme.fg(netColor, `${sign}${netDelta.toFixed(1)}`)}` +
				` ${theme.fg("dim", `(iter ${first.iteration} → iter ${best.iteration})`)}` +
				`  │  ${theme.fg("dim", "★ = best kept iteration")}`,
				width,
			),
		);
	}

	lines.push("");

	return new Text(lines.join("\n"), 0, 0);
}
