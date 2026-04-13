// Skill Auto-Creation with Nudge System
// Inspired by Hermes Agent — periodically prompts the model to capture
// reusable procedural knowledge from successful complex work

export interface NudgeState {
	turnsSinceLastSkillCheck: number;
	turnsSinceLastMemoryCheck: number;
	totalTurns: number;
}

const SKILL_NUDGE_INTERVAL = 10;
const MEMORY_NUDGE_INTERVAL = 15;

export function createNudgeState(): NudgeState {
	return {
		turnsSinceLastSkillCheck: 0,
		turnsSinceLastMemoryCheck: 0,
		totalTurns: 0,
	};
}

export function incrementTurn(state: NudgeState): NudgeState {
	return {
		turnsSinceLastSkillCheck: state.turnsSinceLastSkillCheck + 1,
		turnsSinceLastMemoryCheck: state.turnsSinceLastMemoryCheck + 1,
		totalTurns: state.totalTurns + 1,
	};
}

export function shouldNudgeSkill(state: NudgeState): boolean {
	return state.turnsSinceLastSkillCheck >= SKILL_NUDGE_INTERVAL && state.totalTurns > 5;
}

export function shouldNudgeMemory(state: NudgeState): boolean {
	return state.turnsSinceLastMemoryCheck >= MEMORY_NUDGE_INTERVAL && state.totalTurns > 5;
}

export function resetSkillNudge(state: NudgeState): NudgeState {
	return { ...state, turnsSinceLastSkillCheck: 0 };
}

export function resetMemoryNudge(state: NudgeState): NudgeState {
	return { ...state, turnsSinceLastMemoryCheck: 0 };
}

export const SKILL_NUDGE_MESSAGE =
	"[System: You've been working on a complex task for a while. " +
	"Consider whether any reusable patterns, debugging approaches, or " +
	"architectural decisions from this session should be saved as a skill " +
	"for future use. If so, create a SKILL.md file in the appropriate " +
	"skills directory. If not, continue with the current task.]";

export const MEMORY_NUDGE_MESSAGE =
	"[System: Periodic memory check. Review whether any important context " +
	"from this session should be persisted — project conventions, user " +
	"preferences, tool quirks, or environment facts. Update AGENTS.md or " +
	"the project's instruction files if needed. If nothing notable, continue.]";
