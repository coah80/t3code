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

// Engine
export { runAgentLoop, runSubagent } from './engine/loop.js';
export type { AgentLoopOptions, SubagentOptions } from './engine/loop.js';
export { buildSystemPrompt } from './engine/prompt.js';
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
	discoverSkills,
	loadInstructions,
	getSkillToolDefinition,
	getSkillContent,
} from './skills/loader.js';
export type { Skill } from './skills/loader.js';
