// Agent Harness — main entry point
// Re-exports everything needed to run the agent

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

export { runAgentLoop, runSubagent } from './engine/loop.js';
export type { AgentLoopOptions, SubagentOptions } from './engine/loop.js';

export { buildSystemPrompt } from './engine/prompt.js';

export { executeTool, executeToolsParallel, getToolDefinitions } from './tools/index.js';

export { discoverProjects, createProject, getHomeDir } from './engine/home.js';

export {
	createScheduledTask,
	listScheduledTasks,
	deleteScheduledTask,
	toggleScheduledTask,
	getNextRunTime,
	describeCron,
	PRESET_SCHEDULES,
} from './engine/scheduler.js';
