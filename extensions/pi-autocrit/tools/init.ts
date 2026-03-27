/**
 * init_autocrit tool — validates dependencies and initializes workspace.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { createState, reconstructState, writeConfig, type AutocritRuntime, type AutocritState } from "../state.js";
import { checkDependencies, formatDependencyReport, getPythonDir } from "../utils.js";

export function registerInitTool(pi: ExtensionAPI, getRuntime: () => AutocritRuntime) {
	pi.registerTool({
		name: "init_autocrit",
		label: "Init Autocrit",
		description:
			"Initialize an autocrit evaluation session. Validates dependencies (agent-browser, uv/python, git), " +
			"creates results directory structure, and sets up experiment state. Call once before starting the evaluation loop.",
		promptSnippet: "Initialize autocrit session (mode, experiment name, persona command). Call once before evaluating.",
		promptGuidelines: [
			"Call init_autocrit once at the start of an autocrit session, before calling run_evaluation.",
			"If autocrit.jsonl already exists, init_autocrit will resume from existing state.",
			"The persona_cmd specifies which LLM CLI to use for the persona agent (e.g. 'claude -p', 'pi -p').",
		],
		parameters: Type.Object({
			mode: StringEnum(["full", "quick"] as const, {
				description: "full = 3 prototypes with comparative evaluation, quick = single prototype",
			}),
			experiment_name: Type.String({
				description: "Short name for this experiment (e.g. 'tipcalc', 'recipe-app'). Used in branch names and result directories.",
			}),
			persona_cmd: Type.String({
				description: "Command to run the persona LLM agent (e.g. 'claude -p', 'pi -p'). Must accept input on stdin.",
			}),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const runtime = getRuntime();

			// Check dependencies
			const deps = await checkDependencies((cmd, args) => pi.exec(cmd, args));
			const depReport = formatDependencyReport(deps);

			if (!deps.git || !deps.agentBrowser || (!deps.uv && !deps.python3)) {
				return {
					content: [{ type: "text", text: `❌ Missing dependencies:\n\n${depReport}\n\nInstall the missing dependencies and try again.` }],
					details: { dependencies: deps },
				};
			}

			// Check for persona.md
			const personaPath = path.join(ctx.cwd, "persona.md");
			if (!fs.existsSync(personaPath)) {
				return {
					content: [{ type: "text", text: "❌ persona.md not found in the current directory.\n\nCreate a persona.md first. Read the autocrit skill for instructions, or see the example at references/examples/persona_example.md." }],
					details: {},
				};
			}

			// Set up state — reuse existing resultsDir if resuming the same experiment
			const existingState = reconstructState(ctx.cwd);
			const state = runtime.state;
			state.active = true;
			state.mode = params.mode;
			state.experimentName = params.experiment_name;
			state.personaCmd = params.persona_cmd;

			// Reuse existing iterations from autocrit.jsonl
			if (existingState.active && existingState.iterations.length > 0) {
				state.iterations = existingState.iterations;
			}

			// Create or reuse results directory
			if (existingState.active && existingState.resultsDir
				&& existingState.experimentName === params.experiment_name
				&& fs.existsSync(path.join(ctx.cwd, existingState.resultsDir))) {
				// Reuse existing directory from same experiment
				state.resultsDir = existingState.resultsDir;
			} else if (params.mode === "full") {
				state.resultsDir = `results/${params.experiment_name}`;
			} else {
				const timestamp = new Date().toISOString().slice(0, 16).replace(/[:-]/g, "").replace("T", "_");
				state.resultsDir = `results/${params.experiment_name}_${timestamp}`;
			}
			fs.mkdirSync(path.join(ctx.cwd, state.resultsDir), { recursive: true });

			// Create .gitignore if it doesn't exist
			const gitignorePath = path.join(ctx.cwd, ".gitignore");
			if (!fs.existsSync(gitignorePath)) {
				fs.writeFileSync(gitignorePath, "node_modules/\ndist/\n.DS_Store\n");
			}

			// Write config to autocrit.jsonl
			writeConfig(ctx.cwd, state);

			// Build response
			const pythonDir = getPythonDir();
			const runner = deps.uv ? "uv" : "python3";

			let response = `✅ Autocrit initialized: "${params.experiment_name}"\n`;
			response += `Mode: ${params.mode}\n`;
			response += `Persona agent: ${params.persona_cmd}\n`;
			response += `Results: ${state.resultsDir}\n`;
			response += `Python runner: ${runner}\n`;
			response += `Python scripts: ${pythonDir}\n\n`;
			response += `Dependencies:\n${depReport}\n\n`;

			if (params.mode === "full") {
				response += "Next steps:\n";
				response += "1. Read persona.md and any requirements.md/hypotheses.md\n";
				response += "2. Brainstorm 3 different UX approaches\n";
				response += "3. Create prototype branches (autocrit/<experiment>/proto-a, proto-b, proto-c)\n";
				response += "4. Build seed app on each branch, then run_evaluation with mode 'quick'\n";
			} else {
				response += "Next steps:\n";
				response += "1. Build the seed app (Vite project with package.json)\n";
				response += "2. Run run_evaluation with mode 'quick' to get baseline scores\n";
				response += "3. Iterate: edit → run_evaluation → log_iteration → repeat\n";
			}

			return {
				content: [{ type: "text", text: response }],
				details: { state, dependencies: deps },
			};
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("init_autocrit "));
			text += theme.fg("accent", args.experiment_name ?? "");
			text += theme.fg("dim", ` (${args.mode ?? "quick"})`);
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const t = result.content[0];
			return new Text(t?.type === "text" ? t.text : "", 0, 0);
		},
	});
}
