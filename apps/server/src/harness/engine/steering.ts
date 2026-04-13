// Steering — follow-up behavior during active agent runs
// Simplified from t3code PR #1479's CQRS implementation
//
// Two modes:
// - "steer": Follow-up is injected as invisible guidance into the active run
// - "queue": Follow-up is queued and dispatched after the current run settles

export type FollowUpBehavior = "steer" | "queue";
export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = "steer";

export interface QueuedFollowUp {
	readonly id: string;
	readonly prompt: string;
	readonly createdAt: number;
	readonly modelOverride?: string;
}

export interface SteeringState {
	readonly behavior: FollowUpBehavior;
	readonly queue: readonly QueuedFollowUp[];
	readonly isRunning: boolean;
}

export function createSteeringState(behavior?: FollowUpBehavior): SteeringState {
	return {
		behavior: behavior ?? DEFAULT_FOLLOW_UP_BEHAVIOR,
		queue: [],
		isRunning: false,
	};
}

export function handleFollowUp(
	state: SteeringState,
	prompt: string,
	modelOverride?: string,
): { readonly state: SteeringState; readonly action: "steer" | "enqueue" | "send" } {
	if (!state.isRunning) {
		// Not running — send immediately as a new turn
		return { state, action: "send" };
	}

	if (state.behavior === "steer") {
		// Inject as invisible guidance
		return { state, action: "steer" };
	}

	// Queue it
	const followUp: QueuedFollowUp = {
		id: crypto.randomUUID(),
		prompt,
		createdAt: Date.now(),
		modelOverride,
	};

	return {
		state: { ...state, queue: [...state.queue, followUp] },
		action: "enqueue",
	};
}

export function popQueue(state: SteeringState): {
	readonly state: SteeringState;
	readonly followUp: QueuedFollowUp | null;
} {
	if (state.queue.length === 0) {
		return { state, followUp: null };
	}

	const [head, ...rest] = state.queue;
	return {
		state: { ...state, queue: rest },
		followUp: head ?? null,
	};
}

export function removeFromQueue(state: SteeringState, id: string): SteeringState {
	return { ...state, queue: state.queue.filter((q) => q.id !== id) };
}

export function reorderQueue(state: SteeringState, fromIndex: number, toIndex: number): SteeringState {
	const queue = [...state.queue];
	const [item] = queue.splice(fromIndex, 1);
	if (!item) return state;
	queue.splice(toIndex, 0, item);
	return { ...state, queue };
}

export function setRunning(state: SteeringState, running: boolean): SteeringState {
	return { ...state, isRunning: running };
}

// ─── Behavior Inversion (Cmd+Shift+Enter) ────────────────────────────────────

export function resolveFollowUpBehavior(
	behavior: FollowUpBehavior,
	invert: boolean,
): FollowUpBehavior {
	if (!invert) return behavior;
	return behavior === "queue" ? "steer" : "queue";
}

// ─── Can Dispatch Check ──────────────────────────────────────────────────────

export function canDispatchQueuedFollowUp(state: SteeringState): boolean {
	return state.queue.length > 0 && !state.isRunning;
}
