// Model Switching — change models mid-conversation
// The switch applies after the current turn completes or is interrupted

export interface ModelSwitchRequest {
	readonly targetModel: string;
	readonly targetProvider: "anthropic" | "openai" | "openrouter";
	readonly applyAfter: "current_turn" | "immediate_interrupt";
}

export interface ModelSwitchState {
	readonly currentModel: string;
	readonly currentProvider: "anthropic" | "openai" | "openrouter";
	readonly pendingSwitch: ModelSwitchRequest | null;
}

export function createModelSwitchState(
	model: string,
	provider: "anthropic" | "openai" | "openrouter",
): ModelSwitchState {
	return { currentModel: model, currentProvider: provider, pendingSwitch: null };
}

export function requestModelSwitch(
	state: ModelSwitchState,
	request: ModelSwitchRequest,
): ModelSwitchState {
	return { ...state, pendingSwitch: request };
}

export function applyPendingSwitch(state: ModelSwitchState): ModelSwitchState {
	if (!state.pendingSwitch) return state;

	return {
		currentModel: state.pendingSwitch.targetModel,
		currentProvider: state.pendingSwitch.targetProvider,
		pendingSwitch: null,
	};
}

export function hasPendingSwitch(state: ModelSwitchState): boolean {
	return state.pendingSwitch !== null;
}

// ─── Model Presets ───────────────────────────────────────────────────────────

export const MODEL_PRESETS = [
	// Anthropic
	{ id: "claude-sonnet-4-6", provider: "anthropic" as const, label: "Claude Sonnet 4.6", tier: "standard" },
	{ id: "claude-opus-4-6", provider: "anthropic" as const, label: "Claude Opus 4.6", tier: "premium" },
	{ id: "claude-haiku-4-5", provider: "anthropic" as const, label: "Claude Haiku 4.5", tier: "fast" },

	// OpenAI
	{ id: "gpt-5.4", provider: "openai" as const, label: "GPT-5.4", tier: "premium" },
	{ id: "gpt-5-mini", provider: "openai" as const, label: "GPT-5 Mini", tier: "fast" },
	{ id: "o3-mini", provider: "openai" as const, label: "o3-mini", tier: "reasoning" },

	// OpenRouter (multi-provider)
	{ id: "anthropic/claude-sonnet-4.6", provider: "openrouter" as const, label: "Claude Sonnet 4.6 (OR)", tier: "standard" },
	{ id: "openai/gpt-5.4", provider: "openrouter" as const, label: "GPT-5.4 (OR)", tier: "premium" },
	{ id: "google/gemini-3.1-pro", provider: "openrouter" as const, label: "Gemini 3.1 Pro (OR)", tier: "standard" },
	{ id: "google/gemini-3-flash", provider: "openrouter" as const, label: "Gemini 3 Flash (OR)", tier: "fast" },
] as const;

export type ModelPreset = (typeof MODEL_PRESETS)[number];

export function findModelPreset(modelId: string): ModelPreset | undefined {
	return MODEL_PRESETS.find((p) => p.id === modelId);
}

export function inferProvider(modelId: string): "anthropic" | "openai" | "openrouter" {
	if (modelId.startsWith("claude")) return "anthropic";
	if (modelId.startsWith("gpt") || modelId.startsWith("o3") || modelId.startsWith("o1")) return "openai";
	return "openrouter";
}
