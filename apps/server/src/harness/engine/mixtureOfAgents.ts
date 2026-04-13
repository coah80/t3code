// Mixture of Agents (MoA) — fan hard problems to multiple models in parallel
// Inspired by Hermes Agent — for complex architectural decisions or tricky bugs
// Sends the same prompt to N models, then synthesizes the best answer

export interface MoAConfig {
	readonly models: readonly MoAModel[];
	readonly synthesizer: MoAModel;
	readonly maxParallel?: number;
}

export interface MoAModel {
	readonly id: string;
	readonly provider: "anthropic" | "openai" | "openrouter";
	readonly apiKey: string;
	readonly label: string;
}

export interface MoAResult {
	readonly responses: readonly MoAModelResponse[];
	readonly synthesis: string;
	readonly totalTimeMs: number;
}

export interface MoAModelResponse {
	readonly model: string;
	readonly label: string;
	readonly response: string;
	readonly timeMs: number;
	readonly error?: string;
}

const DEFAULT_MOA_MODELS: readonly Omit<MoAModel, "apiKey">[] = [
	{ id: "claude-sonnet-4-6", provider: "anthropic", label: "Claude Sonnet 4.6" },
	{ id: "gpt-5.4", provider: "openai", label: "GPT-5.4" },
	{ id: "google/gemini-3.1-pro", provider: "openrouter", label: "Gemini 3.1 Pro" },
];

async function callModel(
	model: MoAModel,
	prompt: string,
	systemPrompt: string,
): Promise<MoAModelResponse> {
	const start = Date.now();

	try {
		const baseURL =
			model.provider === "anthropic" ? "https://api.anthropic.com/v1/messages"
			: model.provider === "openai" ? "https://api.openai.com/v1/chat/completions"
			: "https://openrouter.ai/api/v1/chat/completions";

		let response: string;

		if (model.provider === "anthropic") {
			const resp = await fetch(baseURL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": model.apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model: model.id,
					max_tokens: 4096,
					system: systemPrompt,
					messages: [{ role: "user", content: prompt }],
				}),
				signal: AbortSignal.timeout(60000),
			});

			const data = await resp.json() as { content?: Array<{ text?: string }> };
			response = data.content?.map((c) => c.text ?? "").join("") ?? "No response";
		} else {
			const resp = await fetch(baseURL, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${model.apiKey}`,
				},
				body: JSON.stringify({
					model: model.id,
					messages: [
						{ role: "system", content: systemPrompt },
						{ role: "user", content: prompt },
					],
					max_tokens: 4096,
				}),
				signal: AbortSignal.timeout(60000),
			});

			const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
			response = data.choices?.[0]?.message?.content ?? "No response";
		}

		return {
			model: model.id,
			label: model.label,
			response,
			timeMs: Date.now() - start,
		};
	} catch (error) {
		return {
			model: model.id,
			label: model.label,
			response: "",
			timeMs: Date.now() - start,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function runMixtureOfAgents(
	prompt: string,
	config: MoAConfig,
): Promise<MoAResult> {
	const start = Date.now();

	// Fan out to all models in parallel
	const responses = await Promise.all(
		config.models.map((model) =>
			callModel(model, prompt, "You are an expert software engineer. Analyze this problem thoroughly and provide your best solution with reasoning."),
		),
	);

	// Filter successful responses
	const successful = responses.filter((r) => !r.error && r.response.length > 0);

	if (successful.length === 0) {
		return {
			responses,
			synthesis: "All models failed to respond. Errors:\n" +
				responses.map((r) => `- ${r.label}: ${r.error}`).join("\n"),
			totalTimeMs: Date.now() - start,
		};
	}

	// Synthesize using the designated synthesizer model
	const synthesisPrompt = `You received responses from ${successful.length} different AI models to this problem:

<problem>
${prompt}
</problem>

Here are their responses:

${successful.map((r, i) => `<response model="${r.label}">\n${r.response}\n</response>`).join("\n\n")}

Synthesize the best answer by:
1. Identifying the strongest points from each response
2. Resolving any contradictions
3. Combining the best elements into a single, cohesive solution
4. Adding any insights that emerge from comparing the responses

Provide the synthesized solution:`;

	const synthesisResult = await callModel(
		config.synthesizer,
		synthesisPrompt,
		"You are a synthesis expert. Combine multiple expert opinions into the best possible answer.",
	);

	return {
		responses,
		synthesis: synthesisResult.response || "Synthesis failed",
		totalTimeMs: Date.now() - start,
	};
}

export function getDefaultMoAConfig(apiKeys: {
	anthropic?: string;
	openai?: string;
	openrouter?: string;
}): MoAConfig | null {
	const models: MoAModel[] = [];

	if (apiKeys.anthropic) {
		models.push({ id: "claude-sonnet-4-6", provider: "anthropic", apiKey: apiKeys.anthropic, label: "Claude Sonnet 4.6" });
	}
	if (apiKeys.openai) {
		models.push({ id: "gpt-5.4", provider: "openai", apiKey: apiKeys.openai, label: "GPT-5.4" });
	}
	if (apiKeys.openrouter) {
		models.push({ id: "google/gemini-3.1-pro", provider: "openrouter", apiKey: apiKeys.openrouter, label: "Gemini 3.1 Pro" });
	}

	if (models.length < 2) return null;

	return {
		models,
		synthesizer: models[0]!, // Use the first available model as synthesizer
	};
}
