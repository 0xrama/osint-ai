export interface ToolDefinition<TArgs = any, TResult = any> {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	execute(args: TArgs): Promise<TResult>;
}

export interface RuntimeCallbacks {
	onToken?: (token: string) => void;
	onToolCall?: (name: string, args: unknown) => void;
	onToolResult?: (name: string, result: unknown) => void;
	onLog?: (message: string) => void;
}

export interface AgentRunOptions {
	model?: string;
	systemPrompt: string;
	userPrompt: string;
	tools?: ToolDefinition[];
	callbacks?: RuntimeCallbacks;
	maxIterations?: number;
	temperature?: number;
}

export interface AgentRunResult {
	text: string;
	iterations: number;
	toolCalls: number;
}
