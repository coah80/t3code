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
} from "./types";

// Engine — core
export { runAgentLoop, runSubagent } from "./engine/loop";
export type { AgentLoopOptions, SubagentOptions } from "./engine/loop";
export { buildSystemPrompt } from "./engine/prompt";
export { discoverProjects, createProject, getHomeDir } from "./engine/home";
export {
  createScheduledTask,
  listScheduledTasks,
  deleteScheduledTask,
  toggleScheduledTask,
  getNextRunTime,
  describeCron,
  PRESET_SCHEDULES,
} from "./engine/scheduler";

// Engine — steering + model switching
export {
  createSteeringState,
  handleFollowUp,
  popQueue,
  removeFromQueue,
  reorderQueue,
  setRunning,
  resolveFollowUpBehavior,
  canDispatchQueuedFollowUp,
  DEFAULT_FOLLOW_UP_BEHAVIOR,
} from "./engine/steering";
export type { FollowUpBehavior, QueuedFollowUp, SteeringState } from "./engine/steering";
export {
  createModelSwitchState,
  requestModelSwitch,
  applyPendingSwitch,
  hasPendingSwitch,
  MODEL_PRESETS,
  inferProvider,
  findModelPreset,
} from "./engine/modelSwitch";
export type { ModelSwitchState, ModelSwitchRequest, ModelPreset } from "./engine/modelSwitch";

// Engine — Hermes-inspired features
export {
  createNudgeState,
  incrementTurn,
  shouldNudgeSkill,
  shouldNudgeMemory,
  resetSkillNudge,
  resetMemoryNudge,
  SKILL_NUDGE_MESSAGE,
  MEMORY_NUDGE_MESSAGE,
} from "./engine/skillNudge";
export { spillIfNeeded, spillTurnResults, cleanupSpillDir } from "./engine/resultSpill";
export { CheckpointManager } from "./engine/checkpoint";
export type { Checkpoint } from "./engine/checkpoint";
export { runMixtureOfAgents, getDefaultMoAConfig } from "./engine/mixtureOfAgents";
export type { MoAConfig, MoAResult, MoAModelResponse } from "./engine/mixtureOfAgents";

// Tools
export { executeTool, executeToolsParallel, getToolDefinitions } from "./tools/index";

// MCP
export { McpManager } from "./mcp/client";
export type { McpServerConfig, McpTool, McpClient } from "./mcp/client";

// LSP
export { LspManager } from "./lsp/client";
export type { LspDiagnostic, LspServerConfig } from "./lsp/client";

// Skills
export {
  discoverSkills,
  loadInstructions,
  getSkillToolDefinition,
  getSkillContent,
} from "./skills/loader";
export type { Skill } from "./skills/loader";
