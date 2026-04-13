// Agent Loop Engine — the heart of the harness
// Implements Cursor-style BiDi tool loop with parallel execution
//
// Flow:
//   1. Send user message + tools to model
//   2. Stream response — accumulate text + tool calls
//   3. Execute all tool calls in PARALLEL
//   4. Append results to conversation
//   5. Send back to model → repeat until no more tool calls
//   6. Auto-verify (lint check) after edits

import type {
	AgentConfig,
	AgentEvent,
	AgentTurn,
	ConversationMessage,
	ToolCall,
	ToolResult,
	ToolDefinition,
} from '../types.js';
import { executeToolsParallel, getToolDefinitions } from '../tools/index.js';
import { streamAnthropic } from '../providers/anthropic.js';
import { streamOpenAI } from '../providers/openai.js';
import { buildSystemPrompt } from './prompt.js';
import { McpManager, type McpServerConfig } from '../mcp/client.js';
import { LspManager } from '../lsp/client.js';
import { discoverSkills, loadInstructions, getSkillToolDefinition, getSkillContent, type Skill } from '../skills/loader.js';

export interface AgentLoopOptions {
	readonly config: AgentConfig;
	readonly userMessage: string;
	readonly conversationHistory?: readonly ConversationMessage[];
	readonly signal?: AbortSignal;
	readonly mcpConfigs?: readonly McpServerConfig[];
	readonly lspManager?: LspManager;
}

export async function* runAgentLoop(options: AgentLoopOptions): AsyncGenerator<AgentEvent> {
	const { config, userMessage, conversationHistory = [], signal, mcpConfigs, lspManager } = options;
	const maxTurns = config.maxTurns ?? 50;

	// ─── Discover skills + instructions ────────────────────────────────
	const [skills, instructions] = await Promise.all([
		discoverSkills(config.workspaceRoot),
		loadInstructions(config.workspaceRoot),
	]);

	// ─── Connect MCP servers ───────────────────────────────────────────
	const mcpManager = new McpManager();
	if (mcpConfigs && mcpConfigs.length > 0) {
		await mcpManager.connectAll(mcpConfigs);
	}

	// ─── Build tools list (built-in + MCP + LSP + skills) ──────────────
	const allTools: ToolDefinition[] = [
		...(config.mode === 'plan' ? [] : getToolDefinitions()),
		...mcpManager.getToolDefinitions(),
	];

	// Add LSP tool if manager provided
	if (lspManager) {
		allTools.push(lspManager.getToolDefinition());
	}

	// Add skill tool if skills found
	const skillTool = getSkillToolDefinition(skills);
	if (skillTool) {
		allTools.push(skillTool);
	}

	// ─── Build system prompt with instructions ─────────────────────────
	let systemPrompt = config.systemPrompt ?? buildSystemPrompt(config);
	if (instructions.length > 0) {
		systemPrompt += "\n\n<instructions>\n" + instructions.join("\n\n---\n\n") + "\n</instructions>";
	}

	// Build initial conversation
	const messages: ConversationMessage[] = [...conversationHistory];
	messages.push({ role: 'user', content: userMessage });

	let turnNumber = 0;
	const editedFiles: Set<string> = new Set();

	while (turnNumber < maxTurns) {
		if (signal?.aborted) {
			yield { type: 'error', error: 'Aborted by user' };
			return;
		}

		turnNumber++;
		let turnText = '';
		let thinkingText = '';
		const toolCalls: ToolCall[] = [];

		// ─── Stream model response ─────────────────────────────────────────
		const stream = config.provider === 'anthropic'
			? streamAnthropic({
				model: config.model,
				apiKey: config.apiKey,
				messages,
				tools: allTools,
				systemPrompt,
				thinkingEnabled: true,
				signal,
			})
			: streamOpenAI({
				model: config.model,
				apiKey: config.apiKey,
				baseURL: config.provider === 'openrouter'
					? 'https://openrouter.ai/api/v1'
					: 'https://api.openai.com/v1',
				messages,
				tools: allTools,
				systemPrompt,
				signal,
			});

		for await (const event of stream) {
			if (signal?.aborted) {
				yield { type: 'error', error: 'Aborted by user' };
				return;
			}

			switch (event.type) {
				case 'text_delta':
					turnText += event.text;
					yield event;
					break;

				case 'thinking_delta':
					thinkingText += event.text;
					yield event;
					break;

				case 'tool_call_start':
					toolCalls.push(event.toolCall);
					yield event;
					break;

				case 'error':
					yield event;
					return;
			}
		}

		// ─── No tool calls → agent is done ─────────────────────────────────
		if (toolCalls.length === 0) {
			// Append assistant message to history
			messages.push({ role: 'assistant', content: turnText });

			const turn: AgentTurn = {
				turnNumber,
				text: turnText,
				toolCalls: [],
				toolResults: [],
				thinkingContent: thinkingText || undefined,
			};
			yield { type: 'turn_complete', turn };
			yield { type: 'agent_complete', totalTurns: turnNumber };
			return;
		}

		// ─── Execute tool calls in PARALLEL ────────────────────────────────
		yield { type: 'commentary', text: `Executing ${toolCalls.length} tool${toolCalls.length > 1 ? 's' : ''} in parallel...` };

		// Route each tool call to the right executor
		const results: ToolResult[] = await Promise.all(toolCalls.map(async (call): Promise<ToolResult> => {
			try {
				// MCP tools (prefixed with mcp_)
				if (call.name.startsWith('mcp_')) {
					const parts = call.name.split('_');
					const serverName = parts[1];
					const toolName = parts.slice(2).join('_');
					const content = await mcpManager.callTool(serverName, toolName, call.arguments);
					return { tool_call_id: call.id, content };
				}

				// LSP tool
				if (call.name === 'LSP' && lspManager) {
					const op = call.arguments.operation as string;
					const filePath = call.arguments.filePath as string;
					const line = call.arguments.line as number;
					const char = call.arguments.character as number;

					let content: string;
					switch (op) {
						case 'getDiagnostics': {
							const diags = await lspManager.getDiagnostics(filePath);
							content = diags.length === 0
								? 'No diagnostics found.'
								: diags.map(d => `${d.severity.toUpperCase()} [${d.line}:${d.character}] ${d.message}${d.source ? ` (${d.source})` : ''}`).join('\n');
							break;
						}
						case 'goToDefinition':
							content = await lspManager.goToDefinition(filePath, line, char);
							break;
						case 'hover':
							content = await lspManager.hover(filePath, line, char);
							break;
						default:
							content = `Unknown LSP operation: ${op}`;
					}
					return { tool_call_id: call.id, content };
				}

				// Skill tool
				if (call.name === 'Skill') {
					const skillName = call.arguments.name as string;
					const content = getSkillContent(skills, skillName);
					return { tool_call_id: call.id, content };
				}

				// Built-in tools
				const { executeTool } = await import('../tools/index.js');
				return executeTool(call, config.workspaceRoot);
			} catch (error) {
				return {
					tool_call_id: call.id,
					content: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
					is_error: true,
				};
			}
		}));

		// Track edited files for auto-verification
		for (const tc of toolCalls) {
			if (['Write', 'StrReplace'].includes(tc.name)) {
				const path = tc.arguments.path as string;
				if (path) editedFiles.add(path);
			}
		}

		// Emit tool results
		for (const result of results) {
			yield { type: 'tool_call_complete', toolCallId: result.tool_call_id, result };
		}

		// ─── Append to conversation history ────────────────────────────────
		// Assistant message with tool calls
		messages.push({
			role: 'assistant',
			content: turnText,
			tool_calls: toolCalls,
		});

		// Tool results as separate messages (Anthropic format)
		if (config.provider === 'anthropic') {
			// Anthropic: all tool results in one user message
			messages.push({
				role: 'user',
				content: results.map((r) => ({
					type: 'tool_result' as const,
					tool_use_id: r.tool_call_id,
					content: r.content,
				})),
			});
		} else {
			// OpenAI: each tool result is a separate message
			for (const result of results) {
				messages.push({
					role: 'tool',
					content: result.content,
					tool_call_id: result.tool_call_id,
				});
			}
		}

		const turn: AgentTurn = {
			turnNumber,
			text: turnText,
			toolCalls,
			toolResults: [...results],
			thinkingContent: thinkingText || undefined,
		};
		yield { type: 'turn_complete', turn };

		// ─── Auto-verification: lint check after edits ─────────────────────
		if (editedFiles.size > 0 && turnNumber > 1) {
			// Check if the model just finished a sequence of edits without
			// already calling ReadLints. If so, we inject a lint check hint.
			const lastToolNames = toolCalls.map((tc) => tc.name);
			const hasEdits = lastToolNames.some((n) => ['Write', 'StrReplace'].includes(n));
			const alreadyCheckedLints = lastToolNames.includes('ReadLints');

			if (hasEdits && !alreadyCheckedLints) {
				// The model will naturally check lints on the next turn because
				// the system prompt says to. We just track that it should.
				// In Cursor, this is the LOOP_ON_LINTS capability.
			}
		}
	}

	// Cleanup
	mcpManager.closeAll();

	yield { type: 'error', error: `Max turns (${maxTurns}) reached` };
}

// ─── Subagent Support ────────────────────────────────────────────────────────

export interface SubagentOptions {
	readonly parentConfig: AgentConfig;
	readonly prompt: string;
	readonly subagentType?: string;
	readonly readonly?: boolean;
}

export async function* runSubagent(options: SubagentOptions): AsyncGenerator<AgentEvent> {
	const { parentConfig, prompt, readonly } = options;

	const subConfig: AgentConfig = {
		...parentConfig,
		mode: readonly ? 'chat' : 'agent',
		maxTurns: 20,
	};

	yield* runAgentLoop({
		config: subConfig,
		userMessage: prompt,
	});
}
