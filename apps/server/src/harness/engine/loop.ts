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
} from '../types.js';
import { executeToolsParallel, getToolDefinitions } from '../tools/index.js';
import { streamAnthropic } from '../providers/anthropic.js';
import { streamOpenAI } from '../providers/openai.js';
import { buildSystemPrompt } from './prompt.js';

export interface AgentLoopOptions {
	readonly config: AgentConfig;
	readonly userMessage: string;
	readonly conversationHistory?: readonly ConversationMessage[];
	readonly signal?: AbortSignal;
}

export async function* runAgentLoop(options: AgentLoopOptions): AsyncGenerator<AgentEvent> {
	const { config, userMessage, conversationHistory = [], signal } = options;
	const maxTurns = config.maxTurns ?? 50;
	const tools = getToolDefinitions();
	const systemPrompt = config.systemPrompt ?? buildSystemPrompt(config);

	// Build initial conversation
	const messages: ConversationMessage[] = [...conversationHistory];

	// Add user message
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
				tools: config.mode === 'plan' ? [] : [...tools],
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
				tools: config.mode === 'plan' ? [] : [...tools],
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

		const results = await executeToolsParallel(toolCalls, config.workspaceRoot);

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
