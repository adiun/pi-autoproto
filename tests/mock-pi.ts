/**
 * Lightweight mock of pi ExtensionAPI for testing tool registration.
 *
 * Captures registered tools, commands, shortcuts, and event handlers
 * so tests can inspect schemas and call execute() with controlled inputs.
 */

export interface CapturedTool {
	name: string;
	label?: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: Record<string, unknown>;
	execute: (...args: unknown[]) => Promise<unknown>;
	renderCall?: (...args: unknown[]) => unknown;
	renderResult?: (...args: unknown[]) => unknown;
}

export interface MockExecResult {
	code: number | null;
	stdout?: string;
	stderr?: string;
}

export function createMockPi(options?: {
	execHandler?: (cmd: string, args: string[], opts?: unknown) => MockExecResult | Promise<MockExecResult>;
}) {
	const tools: CapturedTool[] = [];
	const commands: Map<string, unknown> = new Map();
	const shortcuts: Map<string, unknown> = new Map();
	const eventHandlers: Map<string, Array<(...args: unknown[]) => Promise<unknown>>> = new Map();
	const entries: Map<string, unknown[]> = new Map();

	const defaultExec = async (_cmd: string, _args: string[]): Promise<MockExecResult> => {
		return { code: 0, stdout: "", stderr: "" };
	};

	const execHandler = options?.execHandler ?? defaultExec;

	const pi = {
		registerTool(def: Record<string, unknown>) {
			tools.push(def as unknown as CapturedTool);
		},

		registerCommand(name: string, handler: unknown) {
			commands.set(name, handler);
		},

		registerShortcut(key: string, handler: unknown) {
			shortcuts.set(key, handler);
		},

		on(event: string, handler: (...args: unknown[]) => Promise<unknown>) {
			if (!eventHandlers.has(event)) {
				eventHandlers.set(event, []);
			}
			eventHandlers.get(event)!.push(handler);
		},

		async exec(cmd: string, args: string[], opts?: unknown): Promise<MockExecResult> {
			return execHandler(cmd, args, opts);
		},

		appendEntry(key: string, value: unknown) {
			if (!entries.has(key)) {
				entries.set(key, []);
			}
			entries.get(key)!.push(value);
		},
	};

	return {
		pi,
		tools,
		commands,
		shortcuts,
		eventHandlers,
		entries,

		/** Get a registered tool by name */
		getTool(name: string): CapturedTool | undefined {
			return tools.find((t) => t.name === name);
		},

		/** Get the schema properties from a tool's parameters */
		getSchemaProperties(toolName: string): Record<string, unknown> | undefined {
			const tool = tools.find((t) => t.name === toolName);
			if (!tool) return undefined;
			return (tool.parameters as Record<string, unknown>).properties as Record<string, unknown>;
		},

		/** Fire an event and return all handler results */
		async fireEvent(event: string, ...args: unknown[]): Promise<unknown[]> {
			const handlers = eventHandlers.get(event) ?? [];
			const results: unknown[] = [];
			for (const handler of handlers) {
				results.push(await handler(...args));
			}
			return results;
		},
	};
}

export type MockPi = ReturnType<typeof createMockPi>;

/**
 * Create a mock Theme for widget testing.
 * Returns strings unchanged (no ANSI codes) so tests can inspect content.
 */
export function createMockTheme() {
	return {
		fg(_color: string, text: string) { return text; },
		bg(_color: string, text: string) { return text; },
		bold(text: string) { return text; },
		italic(text: string) { return text; },
		dim(text: string) { return text; },
		underline(text: string) { return text; },
	};
}
