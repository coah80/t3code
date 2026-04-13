// Anthropic provider — streams Claude responses with tool use
// Implements the model-agnostic provider interface

import type { ToolDefinition, ConversationMessage, AgentEvent } from '../types.js';

interface AnthropicStreamOptions {
	readonly model: string;
	readonly apiKey: string;
	readonly messages: readonly ConversationMessage[];
	readonly tools: readonly ToolDefinition[];
	readonly systemPrompt: string;
	readonly thinkingEnabled?: boolean;
	readonly signal?: AbortSignal;
}

interface AnthropicToolUse {
	readonly type: 'tool_use';
	readonly id: string;
	readonly name: string;
	readonly input: Record<string, unknown>;
}

export async function* streamAnthropic(options: AnthropicStreamOptions): AsyncGenerator<AgentEvent> {
	const { model, apiKey, messages, tools, systemPrompt, thinkingEnabled, signal } = options;

	// Convert tool definitions to Anthropic format
	const anthropicTools = tools.map((t) => ({
		name: t.name,
		description: t.description,
		input_schema: t.input_schema,
	}));

	// Convert messages to Anthropic format
	const anthropicMessages = messages
		.filter((m) => m.role !== 'system')
		.map((m) => {
			if (m.role === 'tool') {
				return {
					role: 'user' as const,
					content: [{
						type: 'tool_result' as const,
						tool_use_id: m.tool_call_id!,
						content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
					}],
				};
			}

			if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
				const content: unknown[] = [];
				if (typeof m.content === 'string' && m.content) {
					content.push({ type: 'text', text: m.content });
				}
				for (const tc of m.tool_calls) {
					content.push({
						type: 'tool_use',
						id: tc.id,
						name: tc.name,
						input: tc.arguments,
					});
				}
				return { role: 'assistant' as const, content };
			}

			return {
				role: m.role as 'user' | 'assistant',
				content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
			};
		});

	const body: Record<string, unknown> = {
		model,
		max_tokens: 16384,
		system: systemPrompt,
		messages: anthropicMessages,
		tools: anthropicTools,
		stream: true,
	};

	if (thinkingEnabled) {
		body.thinking = { type: 'enabled', budget_tokens: 10000 };
	}

	const resp = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'x-api-key': apiKey,
			'anthropic-version': '2023-06-01',
			'anthropic-beta': 'prompt-caching-2024-07-31',
		},
		body: JSON.stringify(body),
		signal,
	});

	if (!resp.ok) {
		const errorText = await resp.text();
		yield { type: 'error', error: `Anthropic API error ${resp.status}: ${errorText}` };
		return;
	}

	const reader = resp.body?.getReader();
	if (!reader) {
		yield { type: 'error', error: 'No response body' };
		return;
	}

	const decoder = new TextDecoder();
	let buffer = '';
	const toolCalls: Map<number, { id: string; name: string; input: string }> = new Map();

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				if (!line.startsWith('data: ')) continue;
				const data = line.slice(6).trim();
				if (data === '[DONE]') continue;

				try {
					const event = JSON.parse(data);

					switch (event.type) {
						case 'content_block_start': {
							const block = event.content_block;
							if (block.type === 'tool_use') {
								toolCalls.set(event.index, {
									id: block.id,
									name: block.name,
									input: '',
								});
							}
							break;
						}

						case 'content_block_delta': {
							const delta = event.delta;
							if (delta.type === 'text_delta') {
								yield { type: 'text_delta', text: delta.text };
							} else if (delta.type === 'thinking_delta') {
								yield { type: 'thinking_delta', text: delta.thinking };
							} else if (delta.type === 'input_json_delta') {
								const existing = toolCalls.get(event.index);
								if (existing) {
									toolCalls.set(event.index, {
										...existing,
										input: existing.input + delta.partial_json,
									});
								}
							}
							break;
						}

						case 'content_block_stop': {
							const tc = toolCalls.get(event.index);
							if (tc) {
								try {
									const parsedInput = JSON.parse(tc.input);
									yield {
										type: 'tool_call_start',
										toolCall: {
											id: tc.id,
											name: tc.name as any,
											arguments: parsedInput,
										},
									};
								} catch {
									yield { type: 'error', error: `Failed to parse tool input for ${tc.name}` };
								}
							}
							break;
						}

						case 'message_stop':
							break;

						case 'error':
							yield { type: 'error', error: event.error?.message ?? 'Unknown Anthropic error' };
							break;
					}
				} catch {
					// Skip unparseable lines
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}
