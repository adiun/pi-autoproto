/**
 * generate_report tool — wraps generate_report.py for comparative synthesis.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateTail, formatSize } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AutocritRuntime } from "../state.js";
import { buildReportCommand, getPythonDir } from "../utils.js";

export function registerReportTool(pi: ExtensionAPI, getRuntime: () => AutocritRuntime) {
	pi.registerTool({
		name: "generate_report",
		label: "Generate Report",
		description:
			"Generate a comparative report across prototype evaluations. " +
			"Reads eval_results.json from each proto-* subdirectory and produces report.md. " +
			"Use after all prototypes have been evaluated in full mode.",
		promptSnippet: "Generate comparative report across prototypes (full mode synthesis).",
		promptGuidelines: [
			"Call generate_report after all prototypes have completed their iteration loops and final evaluations.",
			"Only relevant in full mode (3 prototypes). In quick mode, skip this tool.",
			"Include hypotheses_file if hypotheses.md exists.",
		],
		parameters: Type.Object({
			experiment_dir: Type.String({
				description: "Path to experiment results directory (e.g. 'results/tipcalc')",
			}),
			hypotheses_file: Type.Optional(
				Type.String({ description: "Path to hypotheses.md for hypothesis resolution" }),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const absDir = path.resolve(ctx.cwd, params.experiment_dir);
			if (!fs.existsSync(absDir)) {
				return {
					content: [{ type: "text", text: `❌ Directory not found: ${params.experiment_dir}` }],
					details: {},
				};
			}

			// Check for uv
			let useUv = true;
			try {
				const uvCheck = await pi.exec("which", ["uv"]);
				useUv = uvCheck.code === 0;
			} catch {
				useUv = false;
			}

			const command = buildReportCommand({
				pythonDir: getPythonDir(),
				useUv,
				experimentDir: params.experiment_dir,
				hypothesesFile: params.hypotheses_file,
			});

			const result = await pi.exec("bash", ["-c", command], { signal, timeout: 60 });

			if (result.code !== 0) {
				const output = (result.stdout ?? "") + (result.stderr ?? "");
				return {
					content: [{ type: "text", text: `❌ Report generation failed:\n\n${output.slice(0, 2000)}` }],
					details: { exitCode: result.code },
				};
			}

			// Read the generated report
			const reportPath = path.join(params.experiment_dir, "report.md");
			let reportContent = "";
			try {
				reportContent = fs.readFileSync(path.join(ctx.cwd, reportPath), "utf-8");
			} catch {
				reportContent = "(Could not read generated report)";
			}

			// Truncate for LLM context
			const truncation = truncateTail(reportContent, { maxLines: 100, maxBytes: 12 * 1024 });

			let responseText = `✅ Report generated: ${reportPath}\n\n`;
			responseText += truncation.content;
			if (truncation.truncated) {
				responseText += `\n\n[Truncated — read ${reportPath} for full report]`;
			}

			return {
				content: [{ type: "text", text: responseText }],
				details: { reportPath },
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("generate_report "));
			text += theme.fg("accent", args.experiment_dir ?? "");
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const t = result.content[0];
			const text = t?.type === "text" ? t.text : "";
			const lines = text.split("\n");
			if (lines.length <= 15) return new Text(text, 0, 0);
			return new Text(lines.slice(0, 15).join("\n") + theme.fg("dim", `\n… ${lines.length - 15} more lines (read report.md for full report)`), 0, 0);
		},
	});
}
