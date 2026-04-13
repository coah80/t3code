// MCP Client — connects to Model Context Protocol servers
// Adapted from opencode's MCP architecture
// Supports both local (stdio) and remote (HTTP/SSE) servers

import { spawn } from "child_process";
import type { ToolDefinition } from "../types";

export interface McpServerConfig {
  readonly name: string;
  readonly type: "local" | "remote";
  readonly command?: readonly string[] | undefined;
  readonly url?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
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

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

function parseContentLength(header: string): number | null {
  const match = header.match(/Content-Length:\s*(\d+)/i);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

function createJsonRpcError(message: string): Error {
  return new Error(`MCP JSON-RPC error: ${message}`);
}

// ─── Local Stdio Client ──────────────────────────────────────────────────────

async function createLocalClient(config: McpServerConfig): Promise<McpClient> {
  const command = config.command;
  if (!command || command.length === 0) {
    throw new Error(`MCP server ${config.name}: command is required for local servers`);
  }

  const proc = spawn(command[0]!, command.slice(1) as string[], {
    stdio: ["pipe", "pipe", "pipe"],
    env: config.environment ? { ...process.env, ...config.environment } : process.env,
  });

  const tools: McpTool[] = [];
  let requestId = 0;
  const pendingRequests = new Map<number, PendingRequest>();
  let stdoutBuffer = "";
  let currentContentLength: number | null = null;

  const rejectAllPending = (message: string) => {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    pendingRequests.clear();
  };

  const handleMessage = (msg: unknown) => {
    if (!msg || typeof msg !== "object") {
      return;
    }

    const record = msg as {
      id?: number;
      error?: { message?: string };
      result?: unknown;
    };

    if (record.id === undefined || !pendingRequests.has(record.id)) {
      return;
    }

    const pending = pendingRequests.get(record.id)!;
    pendingRequests.delete(record.id);
    clearTimeout(pending.timeout);

    if (record.error?.message) {
      pending.reject(createJsonRpcError(record.error.message));
      return;
    }

    pending.resolve(record.result);
  };

  proc.stdout!.on("data", (data: Buffer) => {
    stdoutBuffer += data.toString("utf8");

    while (stdoutBuffer.length > 0) {
      if (currentContentLength !== null) {
        if (stdoutBuffer.length < currentContentLength) {
          break;
        }

        const messageText = stdoutBuffer.slice(0, currentContentLength);
        stdoutBuffer = stdoutBuffer.slice(currentContentLength);
        currentContentLength = null;

        try {
          handleMessage(JSON.parse(messageText));
        } catch {
          // Ignore malformed frames from noisy servers.
        }
        continue;
      }

      const headerEnd = stdoutBuffer.indexOf("\r\n\r\n");
      if (headerEnd >= 0) {
        const header = stdoutBuffer.slice(0, headerEnd);
        const contentLength = parseContentLength(header);
        if (contentLength === null) {
          stdoutBuffer = stdoutBuffer.slice(headerEnd + 4);
          continue;
        }
        stdoutBuffer = stdoutBuffer.slice(headerEnd + 4);
        currentContentLength = contentLength;
        continue;
      }

      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }

      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.length === 0) {
        continue;
      }

      try {
        handleMessage(JSON.parse(line));
      } catch {
        // Ignore log lines or partial noise on stdout.
      }
    }
  });

  proc.on("error", (error) => {
    rejectAllPending(`MCP server ${config.name} failed: ${error.message}`);
  });
  proc.on("exit", (code, signal) => {
    rejectAllPending(
      `MCP server ${config.name} exited (${signal ? `signal ${signal}` : `code ${code ?? 0}`}).`,
    );
  });

  function sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`MCP request timeout: ${method}`));
      }, config.timeout ?? 30000);

      pendingRequests.set(id, { resolve, reject, timeout });

      const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
      proc.stdin!.write(header + body);
    });
  }

  function sendNotification(method: string, params?: unknown): void {
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    const header = `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n`;
    proc.stdin!.write(header + body);
  }

  // Initialize
  await sendRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "coahcode", version: "1.0.0" },
  });
  sendNotification("notifications/initialized");

  // List tools
  const toolsResult = (await sendRequest("tools/list", {})) as {
    tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  };
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
      const result = (await sendRequest("tools/call", { name: toolName, arguments: args })) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const textParts = (result.content ?? [])
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text!);
      return textParts.join("\n") || JSON.stringify(result);
    },
    close: () => {
      rejectAllPending(`MCP server ${config.name} closed.`);
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
    },
  };
}

// ─── Remote HTTP Client ──────────────────────────────────────────────────────

async function createRemoteClient(config: McpServerConfig): Promise<McpClient> {
  if (!config.url) throw new Error(`MCP server ${config.name}: url is required for remote servers`);
  const baseUrl: string = config.url;
  let requestId = 0;

  async function mcpRequest(method: string, params?: unknown): Promise<unknown> {
    const id = ++requestId;
    const resp = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...config.headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(config.timeout ?? 30000) as AbortSignal,
    });
    if (!resp.ok) {
      throw new Error(`MCP HTTP error ${resp.status}: ${await resp.text()}`);
    }
    const result = (await resp.json()) as { error?: { message: string }; result?: unknown };
    if (result.error) throw new Error(result.error.message);
    return result.result;
  }

  await mcpRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "coahcode", version: "1.0.0" },
  });

  const toolsResult = (await mcpRequest("tools/list")) as {
    tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
  };
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
      const result = (await mcpRequest("tools/call", { name: toolName, arguments: args })) as {
        content?: Array<{ type: string; text?: string }>;
      };
      return (
        (result.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text!)
          .join("\n") || JSON.stringify(result)
      );
    },
    close: () => {
      /* HTTP clients are stateless */
    },
  };
}

// ─── MCP Manager ─────────────────────────────────────────────────────────────

export class McpManager {
  private readonly clients = new Map<string, McpClient>();

  async connect(config: McpServerConfig): Promise<McpClient> {
    if (config.enabled === false) throw new Error(`MCP server ${config.name} is disabled`);

    const existing = this.clients.get(config.name);
    if (existing) return existing;

    const client =
      config.type === "local" ? await createLocalClient(config) : await createRemoteClient(config);

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

  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
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
