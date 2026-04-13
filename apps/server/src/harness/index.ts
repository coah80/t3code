// CoahCode Agent Harness — main entry point

// Types
export type {
	AgentConfig,
	AgentEvent,
	AgentTurn,
	AgentMode,
	ToolCall,
	ToolResult,
	ToolDefinition,
	ToolName,
	ConversationMessage,
	WorkspaceInfo,
	ScheduledTask,
	Todo,
} from './types.js';

// Engine — core
export { runAgentLoop, runSubagent } from './engine/loop.js';
export type { AgentLoopOptions, SubagentOptions } from './engine/loop.js';
export { buildSystemPrompt } from './engine/prompt.js';
export { discoverProjects, createProject, getHomeDir } from './engine/home.js';
export {
	createScheduledTask, listScheduledTasks, deleteScheduledTask,
	toggleScheduledTask, getNextRunTime, describeCron, PRESET_SCHEDULES,
} from './engine/scheduler.js';

// Engine — steering + model switching
export {
	createSteeringState, handleFollowUp, popQueue, removeFromQueue,
	reorderQueue, setRunning, resolveFollowUpBehavior, canDispatchQueuedFollowUp,
	DEFAULT_FOLLOW_UP_BEHAVIOR, SKILL_NUDGE_MESSAGE, MEMORY_NUDGE_MESSAGE,
} from './engine/steering.js';
export type { FollowUpBehavior, QueuedFollowUp, SteeringState } from './engine/steering.js';
export {
	createModelSwitchState, requestModelSwitch, applyPendingSwitch,
	hasPendingSwitch, MODEL_PRESETS, inferProvider, findModelPreset,
} from './engine/modelSwitch.js';
export type { ModelSwitchState, ModelSwitchRequest, ModelPreset } from './engine/modelSwitch.js';

// Engine — Hermes-inspired features
export {
	createNudgeState, incrementTurn, shouldNudgeSkill, shouldNudgeMemory,
	resetSkillNudge, resetMemoryNudge,
} from './engine/skillNudge.js';
export { spillIfNeeded, spillTurnResults, cleanupSpillDir } from './engine/resultSpill.js';
export { CheckpointManager } from './engine/checkpoint.js';
export type { Checkpoint } from './engine/checkpoint.js';
export { runMixtureOfAgents, getDefaultMoAConfig } from './engine/mixtureOfAgents.js';
export type { MoAConfig, MoAResult, MoAModelResponse } from './engine/mixtureOfAgents.js';

// Tools
export { executeTool, executeToolsParallel, getToolDefinitions } from './tools/index.js';

// MCP
export { McpManager } from './mcp/client.js';
export type { McpServerConfig, McpTool, McpClient } from './mcp/client.js';

// LSP
export { LspManager } from './lsp/client.js';
export type { LspDiagnostic, LspServerConfig } from './lsp/client.js';

// Skills
export {
	discoverSkills, loadInstructions, getSkillToolDefinition, getSkillContent,
} from './skills/loader.js';
export type { Skill } from './skills/loader.js';
