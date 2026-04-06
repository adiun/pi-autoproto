/**
 * Dashboard widget rendering for pi-autoproto.
 */

import type { Theme } from "@mariozechner/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { AutoprotoState, IterationResult } from "./state.js";
import { currentBranchIterations, bestIteration, taskScoreStats } from "./state.js";
import { formatDuration, getElapsedMs, sparkline } from "./utils.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IterationFeedbackData {
	iteration: number;
	tasks: Array<{
		number: number;
		name: string;
		tier: string;
		completed: boolean;
		score: number;
		persona_feedback: string;
		stuck_points: string[];
		wishlist: string[];
		timed_out?: boolean;
	}>;
}

// ---------------------------------------------------------------------------
// Compact one-liner widget
// ---------------------------------------------------------------------------

export function renderCompactWidget(state: AutoprotoState, theme: Theme): Text {
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

function renderExpandedLines(state: AutoprotoState, theme: Theme, hint: string): string[] {
	const width = process.stdout.columns || 120;
	const lines: string[] = [];

	// ── Header bar ──────────────────────────────────────────────────────
	const label = `🎯 autoproto${state.experimentName ? `: ${state.experimentName}` : ""}`;
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
		return lines;
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
				deltaStr = theme.fg("success", `+${delta.toFixed(1)}`.padEnd(col.delta));
			} else if (delta < 0) {
				deltaStr = theme.fg("error", `${delta.toFixed(1)}`.padEnd(col.delta));
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

	return lines;
}

// ---------------------------------------------------------------------------
// Expanded dashboard
// ---------------------------------------------------------------------------

export function renderExpandedWidget(state: AutoprotoState, theme: Theme): Text {
	const lines = renderExpandedLines(state, theme, " ctrl+x detail ");
	return new Text(lines.join("\n"), 0, 0);
}

// ---------------------------------------------------------------------------
// Fullscreen dashboard with persona feedback
// ---------------------------------------------------------------------------

export function renderFullscreenWidget(
	state: AutoprotoState,
	theme: Theme,
	feedbackData: IterationFeedbackData[],
): Text {
	const lines = renderExpandedLines(state, theme, " ctrl+x collapse ");
	const width = process.stdout.columns || 120;

	// Remove trailing empty lines from expanded section
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
		lines.pop();
	}
	lines.push("");

	// ── Persona Feedback section ────────────────────────────────────────
	const sectionLabel = "Persona Feedback";
	const sectionFill = Math.max(0, width - 6 - sectionLabel.length - 2);
	lines.push(
		truncateToWidth(
			`  ${theme.fg("borderMuted", "─── ")}${theme.fg("accent", sectionLabel)}${theme.fg("borderMuted", " " + "─".repeat(sectionFill))}`,
			width,
		),
	);
	lines.push("");

	if (feedbackData.length === 0) {
		lines.push(`  ${theme.fg("dim", "No evaluation feedback available. Run run_evaluation to get started.")}`);
		lines.push("");
		return new Text(lines.join("\n"), 0, 0);
	}

	// Collect all tasks across iterations, preserving order
	const taskMap = new Map<number, {
		name: string;
		tier: string;
		entries: Array<{
			iteration: number;
			score: number;
			completed: boolean;
			timedOut: boolean;
			feedback: string;
			stuckPoints: string[];
			wishlist: string[];
		}>;
	}>();

	for (const iterData of feedbackData) {
		for (const task of iterData.tasks) {
			if (!taskMap.has(task.number)) {
				taskMap.set(task.number, {
					name: task.name,
					tier: task.tier,
					entries: [],
				});
			}
			taskMap.get(task.number)!.entries.push({
				iteration: iterData.iteration,
				score: task.score,
				completed: task.completed,
				timedOut: task.timed_out ?? false,
				feedback: task.persona_feedback,
				stuckPoints: task.stuck_points,
				wishlist: task.wishlist,
			});
		}
	}

	// Render per-task feedback
	const maxEntries = 5;

	for (const [taskNum, task] of taskMap) {
		const latestEntry = task.entries[task.entries.length - 1];
		const latestStatus = latestEntry.timedOut ? "TIMEOUT" : latestEntry.completed ? "PASS" : "FAIL";
		const latestColor: Parameters<typeof theme.fg>[0] = latestEntry.completed
			? "success" : latestEntry.timedOut ? "warning" : "error";

		// Show variance stats if available
		const stats = taskScoreStats(state, taskNum);
		const varianceStr = stats
			? theme.fg("dim", ` (range: ${stats.min}–${stats.max}, stdev ${stats.stdev}${stats.stdev > 15 ? " ← noisy" : ""})`)
			: "";

		// Show blocked indicator
		const isBlocked = state.blockedTasks.includes(taskNum);
		const blockedStr = isBlocked ? theme.fg("warning", " [BLOCKED]") : "";

		lines.push(
			truncateToWidth(
				`  ${theme.fg("accent", `Task ${taskNum}`)} ${theme.fg("dim", `[${task.tier}]`)} ` +
				`${theme.fg("text", `"${task.name}"`)} — ${theme.fg(latestColor, latestStatus)}${blockedStr}${varianceStr}`,
				width,
			),
		);

		// Show entries from recent iterations
		const startIdx = Math.max(0, task.entries.length - maxEntries);
		if (startIdx > 0) {
			lines.push(`    ${theme.fg("dim", `… ${startIdx} earlier iteration${startIdx === 1 ? "" : "s"}`)}`);
		}

		for (let i = startIdx; i < task.entries.length; i++) {
			const entry = task.entries[i];
			const status = entry.timedOut ? "TIMEOUT" : entry.completed ? "PASS" : "FAIL";
			const color: Parameters<typeof theme.fg>[0] = entry.completed
				? "success" : entry.timedOut ? "warning" : "error";

			const iterLabel = `iter ${String(entry.iteration).padStart(2)}`;
			const scoreLabel = `${String(entry.score).padStart(3)} ${status.padEnd(7)}`;
			const prefixLen = 4 + iterLabel.length + 2 + scoreLabel.length + 3;
			const feedbackWidth = Math.max(20, width - prefixLen);

			let feedbackStr = entry.feedback
				? entry.feedback.replace(/\n/g, " ").trim()
				: "(no feedback)";
			if (feedbackStr.length > feedbackWidth) {
				feedbackStr = feedbackStr.substring(0, feedbackWidth - 1) + "…";
			}

			lines.push(
				truncateToWidth(
					`    ${theme.fg("dim", iterLabel)} ${theme.fg(color, `(${scoreLabel})`)}: ` +
					`${theme.fg("muted", feedbackStr)}`,
					width,
				),
			);
		}

		// Stuck points from latest
		if (latestEntry.stuckPoints && latestEntry.stuckPoints.length > 0) {
			lines.push(
				truncateToWidth(
					`    ${theme.fg("error", "Stuck:")} ${theme.fg("muted", latestEntry.stuckPoints.join("; "))}`,
					width,
				),
			);
		}

		// Wishlist from latest
		if (latestEntry.wishlist && latestEntry.wishlist.length > 0) {
			for (const wish of latestEntry.wishlist) {
				lines.push(
					truncateToWidth(
						`    ${theme.fg("warning", "•")} ${theme.fg("muted", wish)}`,
						width,
					),
				);
			}
		}

		lines.push(""); // blank line between tasks
	}

	return new Text(lines.join("\n"), 0, 0);
}
