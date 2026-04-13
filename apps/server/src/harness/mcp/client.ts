// MCP Client — connects to Model Context Protocol servers
// Adapted from opencode's MCP architecture
// Supports both local (stdio) and remote (HTTP/SSE) servers

import { spawn, type ChildProcess } from "child_process";
import type { ToolDefinition } from "../types";

export interface McpServerConfig {
	readonly name: string;
	readonly type: "local" | "remote";
	readonly command?: readonly string[] | undefined;
	readonly url?: string | undefined;
	readonly environment?: Readonly<Record<string, string>> | undefined;
	readonly enabled?: boolean | undefined;
	readonly timeout?: number | undefined;
}

export interface McpTool {
	readonly serverName: string;
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

export interface McpClient {
	readonly serverName: string;
	readonly tools: readonly McpTool[];
	readonly call: (toolName: string, args: Record<string, unknown>) => Promise<string>;
	readonly close: () => void;
}

// ─── Local Stdio Client ──────────────────────────────────────────────────────

async function createLocalClient(config: McpServerConfig): Promise<McpClient> {
	const command = config.command;
	if (!command || command.length === 0) {
		throw new Error(`MCP server ${config.name}: command is required for local servers`);
	}

	const proc = spawn(command[0]!, command.slice(1) as string[], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...(config.environment ?? {}) },
	});

	const tools: McpTool[] = [];
	let requestId = 0;
	const pendingRequests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

	// JSON-RPC over stdio
	let buffer = "";
	proc.stdout!.on("data", (data: Buffer) => {
		buffer += data.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				const msg = JSON.parse(line);
				if (msg.id !== undefined && pendingRequests.has(msg.id)) {
					const pending = pendingRequests.get(msg.id)!;
					pendingRequests.delete(msg.id);
					if (msg.error) {
						pending.reject(new Error(msg.error.message ?? "MCP error"));
					} else {
						pending.resolve(msg.result);
					}
				}
			} catch {
				// Skip non-JSON lines
			}
		}
	});

	function sendRequest(method: string, params?: unknown): Promise<unknown> {
		const id = ++requestId;
		return new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				pendingRequests.delete(id);
				reject(new Error(`MCP request timeout: ${method}`));
			}, config.timeout ?? 30000);

			pendingRequests.set(id, {
				resolve: (v) => { clearTimeout(timeout); resolve(v); },
				reject: (e) => { clearTimeout(timeout); reject(e); },
			});

			const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
			proc.stdin!.write(msg);
		});
	}

	// Initialize
	await sendRequest("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "coahcode", version: "1.0.0" },
	});

	// List tools
	const toolsResult = await sendRequest("tools/list") as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
	for (const t of toolsResult.tools ?? []) {
		tools.push({
			serverName: config.name,
			name: t.name,
			description: t.description ?? "",
			inputSchema: t.inputSchema ?? { type: "object", properties: {} },
		});
	}

	return {
		serverName: config.name,
		tools,
		call: async (toolName, args) => {
			const result = await sendRequest("tools/call", { name: toolName, arguments: args }) as { content?: Array<{ type: string; text?: string }> };
			const textParts = (result.content ?? [])
				.filter((c) => c.type === "text" && c.text)
				.map((c) => c.text!);
			return textParts.join("\n") || JSON.stringify(result);
		},
		close: () => {
			try { proc.kill(); } catch { /* already dead */ }
		},
	};
}

// ─── Remote HTTP Client ──────────────────────────────────────────────────────

async function createRemoteClient(config: McpServerConfig): Promise<McpClient> {
	if (!config.url) throw new Error(`MCP server ${config.name}: url is required for remote servers`);
	const baseUrl: string = config.url;

	async function mcpRequest(method: string, params?: unknown): Promise<unknown> {
		const resp = await fetch(baseUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
			signal: AbortSignal.timeout(config.timeout ?? 30000) as AbortSignal,
		});
		const result = await resp.json() as { error?: { message: string }; result?: unknown };
		if (result.error) throw new Error(result.error.message);
		return result.result;
	}

	await mcpRequest("initialize", {
		protocolVersion: "2024-11-05",
		capabilities: {},
		clientInfo: { name: "coahcode", version: "1.0.0" },
	});

	const toolsResult = await mcpRequest("tools/list") as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
	const tools: McpTool[] = (toolsResult.tools ?? []).map((t) => ({
		serverName: config.name,
		name: t.name,
		description: t.description ?? "",
		inputSchema: t.inputSchema ?? { type: "object", properties: {} },
	}));

	return {
		serverName: config.name,
		tools,
		call: async (toolName, args) => {
			const result = await mcpRequest("tools/call", { name: toolName, arguments: args }) as { content?: Array<{ type: string; text?: string }> };
			return (result.content ?? []).filter((c) => c.type === "text").map((c) => c.text!).join("\n") || JSON.stringify(result);
		},
		close: () => { /* HTTP clients are stateless */ },
	};
}

// ─── MCP Manager ─────────────────────────────────────────────────────────────

export class McpManager {
	private readonly clients = new Map<string, McpClient>();

	async connect(config: McpServerConfig): Promise<McpClient> {
		if (config.enabled === false) throw new Error(`MCP server ${config.name} is disabled`);

		const existing = this.clients.get(config.name);
		if (existing) return existing;

		const client = config.type === "local"
			? await createLocalClient(config)
			: await createRemoteClient(config);

		this.clients.set(config.name, client);
		return client;
	}

	async connectAll(configs: readonly McpServerConfig[]): Promise<void> {
		const enabled = configs.filter((c) => c.enabled !== false);
		await Promise.allSettled(enabled.map((c) => this.connect(c)));
	}

	getAllTools(): readonly McpTool[] {
		const allTools: McpTool[] = [];
		for (const client of this.clients.values()) {
			allTools.push(...client.tools);
		}
		return allTools;
	}

	getToolDefinitions(): readonly ToolDefinition[] {
		return this.getAllTools().map((t) => ({
			name: `mcp_${t.serverName}_${t.name}` as any,
			description: `[MCP: ${t.serverName}] ${t.description}`,
			input_schema: t.inputSchema,
		}));
	}

	async callTool(serverName: string, toolName: string, args: Record<string, unknown>): Promise<string> {
		const client = this.clients.get(serverName);
		if (!client) throw new Error(`MCP server not connected: ${serverName}`);
		return client.call(toolName, args);
	}

	closeAll(): void {
		for (const client of this.clients.values()) {
			client.close();
		}
		this.clients.clear();
	}
}
