// OpenAI provider — streams GPT/OpenRouter responses with tool use
// Works with OpenAI, OpenRouter, and any OpenAI-compatible API

import type { ToolDefinition, ConversationMessage, AgentEvent } from '../types';

interface OpenAIStreamOptions {
	readonly model: string;
	readonly apiKey: string;
	readonly baseURL?: string | undefined;
	readonly messages: readonly ConversationMessage[];
	readonly tools: readonly ToolDefinition[];
	readonly systemPrompt: string;
	readonly reasoningEffort?: 'low' | 'medium' | 'high' | undefined;
	readonly signal?: AbortSignal | undefined;
}

export async function* streamOpenAI(options: OpenAIStreamOptions): AsyncGenerator<AgentEvent> {
	const {
		model,
		apiKey,
		baseURL = 'https://api.openai.com/v1',
		messages,
		tools,
		systemPrompt,
		reasoningEffort,
		signal,
	} = options;

	// Convert tool definitions to OpenAI format
	const openaiTools = tools.map((t) => ({
		type: 'function' as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: t.input_schema,
		},
	}));

	// Convert messages to OpenAI format
	const openaiMessages: Record<string, unknown>[] = [
		{ role: 'system', content: systemPrompt },
	];

	for (const m of messages) {
		if (m.role === 'system') continue;

		if (m.role === 'tool') {
			openaiMessages.push({
				role: 'tool',
				tool_call_id: m.tool_call_id,
				content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
			});
			continue;
		}

		if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
			openaiMessages.push({
				role: 'assistant',
				content: typeof m.content === 'string' ? m.content : null,
				tool_calls: m.tool_calls.map((tc) => ({
					id: tc.id,
					type: 'function',
					function: {
						name: tc.name,
						arguments: JSON.stringify(tc.arguments),
					},
				})),
			});
			continue;
		}

		openaiMessages.push({
			role: m.role,
			content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
		});
	}

	const body: Record<string, unknown> = {
		model,
		messages: openaiMessages,
		tools: openaiTools.length > 0 ? openaiTools : undefined,
		stream: true,
		parallel_tool_calls: true,
	};

	if (reasoningEffort) {
		body.reasoning_effort = reasoningEffort;
	}

	const resp = await fetch(`${baseURL}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify(body),
		...(signal ? { signal } : {}),
	});

	if (!resp.ok) {
		const errorText = await resp.text();
		yield { type: 'error', error: `OpenAI API error ${resp.status}: ${errorText}` };
		return;
	}

	const reader = resp.body?.getReader();
	if (!reader) {
		yield { type: 'error', error: 'No response body' };
		return;
	}

	const decoder = new TextDecoder();
	let buffer = '';
	const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

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
					const chunk = JSON.parse(data);
					const choice = chunk.choices?.[0];
					if (!choice) continue;

					const delta = choice.delta;
					if (!delta) continue;

					// Text content
					if (delta.content) {
						yield { type: 'text_delta', text: delta.content };
					}

					// Reasoning (for o-series models)
					if (delta.reasoning) {
						yield { type: 'thinking_delta', text: delta.reasoning };
					}

					// Tool calls — OpenAI streams them incrementally
					if (delta.tool_calls) {
						for (const tc of delta.tool_calls) {
							const idx = tc.index;
							const existing = toolCalls.get(idx);

							if (tc.id) {
								// New tool call starting
								toolCalls.set(idx, {
									id: tc.id,
									name: tc.function?.name ?? existing?.name ?? '',
									arguments: tc.function?.arguments ?? '',
								});
							} else if (existing) {
								// Continuing to stream arguments
								toolCalls.set(idx, {
									...existing,
									name: tc.function?.name ?? existing.name,
									arguments: existing.arguments + (tc.function?.arguments ?? ''),
								});
							}
						}
					}

					// Check if this is the final chunk (finish_reason)
					if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') {
						// Emit all accumulated tool calls
						for (const [, tc] of toolCalls) {
							try {
								const parsedArgs = tc.arguments ? JSON.parse(tc.arguments) : {};
								yield {
									type: 'tool_call_start',
									toolCall: {
										id: tc.id,
										name: tc.name as any,
										arguments: parsedArgs,
									},
								};
							} catch {
								yield { type: 'error', error: `Failed to parse tool arguments for ${tc.name}` };
							}
						}
						toolCalls.clear();
					}
				} catch {
					// Skip unparseable chunks
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}
