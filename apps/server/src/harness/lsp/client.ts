// LSP Client — connects to Language Server Protocol servers for diagnostics
// Spawns LSP servers lazily per language, provides diagnostics + go-to-definition

import { spawn, type ChildProcess } from "child_process";
import { promises as fs } from "fs";
import { dirname, extname } from "path";
import type { ToolDefinition } from "../types.js";

export interface LspDiagnostic {
	readonly file: string;
	readonly line: number;
	readonly character: number;
	readonly severity: "error" | "warning" | "info" | "hint";
	readonly message: string;
	readonly source?: string;
}

export interface LspServerConfig {
	readonly id: string;
	readonly extensions: readonly string[];
	readonly command: readonly string[];
	readonly rootMarkers?: readonly string[];
}

interface LspConnection {
	readonly proc: ChildProcess;
	readonly root: string;
	readonly id: string;
	requestId: number;
	readonly pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
	readonly diagnostics: Map<string, readonly LspDiagnostic[]>;
	buffer: string;
}

// ─── Built-in Server Definitions ─────────────────────────────────────────────

const BUILTIN_SERVERS: readonly LspServerConfig[] = [
	{
		id: "typescript",
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
		command: ["typescript-language-server", "--stdio"],
		rootMarkers: ["package.json", "tsconfig.json"],
	},
	{
		id: "python",
		extensions: [".py"],
		command: ["pyright-langserver", "--stdio"],
		rootMarkers: ["pyproject.toml", "setup.py", "requirements.txt"],
	},
	{
		id: "go",
		extensions: [".go"],
		command: ["gopls"],
		rootMarkers: ["go.mod"],
	},
	{
		id: "rust",
		extensions: [".rs"],
		command: ["rust-analyzer"],
		rootMarkers: ["Cargo.toml"],
	},
	{
		id: "css",
		extensions: [".css", ".scss", ".less"],
		command: ["css-languageserver", "--stdio"],
		rootMarkers: ["package.json"],
	},
];

// ─── Root Detection ──────────────────────────────────────────────────────────

async function findProjectRoot(filePath: string, markers: readonly string[]): Promise<string> {
	let dir = dirname(filePath);
	const root = "/";

	while (dir !== root) {
		for (const marker of markers) {
			try {
				await fs.access(`${dir}/${marker}`);
				return dir;
			} catch { /* not found */ }
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return dirname(filePath);
}

// ─── LSP JSON-RPC Transport ─────────────────────────────────────────────────

function parseContentLength(header: string): number | null {
	const match = header.match(/Content-Length:\s*(\d+)/i);
	return match ? parseInt(match[1], 10) : null;
}

function createConnection(config: LspServerConfig, root: string): LspConnection {
	const proc = spawn(config.command[0], config.command.slice(1) as string[], {
		cwd: root,
		stdio: ["pipe", "pipe", "pipe"],
	});

	const conn: LspConnection = {
		proc,
		root,
		id: config.id,
		requestId: 0,
		pending: new Map(),
		diagnostics: new Map(),
		buffer: "",
	};

	// Parse LSP JSON-RPC messages (Content-Length header + JSON body)
	let headerBuffer = "";
	let bodyLength: number | null = null;
	let bodyBuffer = "";

	proc.stdout!.on("data", (chunk: Buffer) => {
		const data = chunk.toString();

		if (bodyLength === null) {
			headerBuffer += data;
			const headerEnd = headerBuffer.indexOf("\r\n\r\n");
			if (headerEnd >= 0) {
				bodyLength = parseContentLength(headerBuffer.substring(0, headerEnd));
				bodyBuffer = headerBuffer.substring(headerEnd + 4);
				headerBuffer = "";
			}
		} else {
			bodyBuffer += data;
		}

		while (bodyLength !== null && bodyBuffer.length >= bodyLength) {
			const messageText = bodyBuffer.substring(0, bodyLength);
			bodyBuffer = bodyBuffer.substring(bodyLength);
			bodyLength = null;

			try {
				const msg = JSON.parse(messageText);

				// Handle responses
				if (msg.id !== undefined && conn.pending.has(msg.id)) {
					const p = conn.pending.get(msg.id)!;
					conn.pending.delete(msg.id);
					if (msg.error) {
						p.reject(new Error(msg.error.message));
					} else {
						p.resolve(msg.result);
					}
				}

				// Handle diagnostics notifications
				if (msg.method === "textDocument/publishDiagnostics" && msg.params) {
					const uri = msg.params.uri as string;
					const file = uri.startsWith("file://") ? uri.slice(7) : uri;
					const diags: LspDiagnostic[] = (msg.params.diagnostics ?? []).map((d: any) => ({
						file,
						line: (d.range?.start?.line ?? 0) + 1,
						character: (d.range?.start?.character ?? 0) + 1,
						severity: (["", "error", "warning", "info", "hint"] as const)[d.severity ?? 1] ?? "error",
						message: d.message ?? "",
						source: d.source,
					}));
					conn.diagnostics.set(file, diags);
				}
			} catch { /* skip */ }

			// Check for next message header in remaining buffer
			const nextHeader = bodyBuffer.indexOf("\r\n\r\n");
			if (nextHeader >= 0) {
				bodyLength = parseContentLength(bodyBuffer.substring(0, nextHeader));
				bodyBuffer = bodyBuffer.substring(nextHeader + 4);
			}
		}
	});

	return conn;
}

function sendLspRequest(conn: LspConnection, method: string, params?: unknown): Promise<unknown> {
	const id = ++conn.requestId;
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			conn.pending.delete(id);
			reject(new Error(`LSP request timeout: ${method}`));
		}, 10000);

		conn.pending.set(id, {
			resolve: (v) => { clearTimeout(timeout); resolve(v); },
			reject: (e) => { clearTimeout(timeout); reject(e); },
		});

		const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
		conn.proc.stdin!.write(header + body);
	});
}

function sendLspNotification(conn: LspConnection, method: string, params?: unknown): void {
	const body = JSON.stringify({ jsonrpc: "2.0", method, params });
	const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
	conn.proc.stdin!.write(header + body);
}

// ─── LSP Manager ─────────────────────────────────────────────────────────────

export class LspManager {
	private readonly connections = new Map<string, LspConnection>();
	private readonly customServers: LspServerConfig[] = [];

	addServer(config: LspServerConfig): void {
		this.customServers.push(config);
	}

	private findServerForFile(filePath: string): LspServerConfig | null {
		const ext = extname(filePath).toLowerCase();
		const allServers = [...this.customServers, ...BUILTIN_SERVERS];
		return allServers.find((s) => s.extensions.includes(ext)) ?? null;
	}

	async ensureConnection(filePath: string): Promise<LspConnection | null> {
		const server = this.findServerForFile(filePath);
		if (!server) return null;

		const root = await findProjectRoot(filePath, server.rootMarkers ?? ["package.json"]);
		const key = `${server.id}:${root}`;

		const existing = this.connections.get(key);
		if (existing) return existing;

		try {
			const conn = createConnection(server, root);

			await sendLspRequest(conn, "initialize", {
				processId: process.pid,
				rootUri: `file://${root}`,
				capabilities: {
					textDocument: {
						publishDiagnostics: { relatedInformation: true },
						definition: { dynamicRegistration: false },
						references: { dynamicRegistration: false },
						hover: { dynamicRegistration: false, contentFormat: ["plaintext"] },
					},
				},
			});

			sendLspNotification(conn, "initialized");

			this.connections.set(key, conn);
			return conn;
		} catch {
			return null;
		}
	}

	async getDiagnostics(filePath: string): Promise<readonly LspDiagnostic[]> {
		const conn = await this.ensureConnection(filePath);
		if (!conn) return [];

		// Touch the file to trigger diagnostics
		try {
			const content = await fs.readFile(filePath, "utf-8");
			sendLspNotification(conn, "textDocument/didOpen", {
				textDocument: {
					uri: `file://${filePath}`,
					languageId: this.guessLanguageId(filePath),
					version: 1,
					text: content,
				},
			});

			// Wait briefly for diagnostics
			await new Promise((r) => setTimeout(r, 1000));
		} catch { /* file might not exist */ }

		return conn.diagnostics.get(filePath) ?? [];
	}

	async goToDefinition(filePath: string, line: number, character: number): Promise<string> {
		const conn = await this.ensureConnection(filePath);
		if (!conn) return "No LSP server available for this file type.";

		try {
			const result = await sendLspRequest(conn, "textDocument/definition", {
				textDocument: { uri: `file://${filePath}` },
				position: { line: line - 1, character: character - 1 },
			}) as any;

			if (!result) return "No definition found.";

			const locations = Array.isArray(result) ? result : [result];
			return locations.map((loc: any) => {
				const uri = loc.uri ?? loc.targetUri ?? "";
				const file = uri.startsWith("file://") ? uri.slice(7) : uri;
				const range = loc.range ?? loc.targetRange;
				const startLine = (range?.start?.line ?? 0) + 1;
				return `${file}:${startLine}`;
			}).join("\n");
		} catch (e) {
			return `LSP error: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	async hover(filePath: string, line: number, character: number): Promise<string> {
		const conn = await this.ensureConnection(filePath);
		if (!conn) return "No LSP server available for this file type.";

		try {
			const result = await sendLspRequest(conn, "textDocument/hover", {
				textDocument: { uri: `file://${filePath}` },
				position: { line: line - 1, character: character - 1 },
			}) as any;

			if (!result?.contents) return "No hover info.";
			const contents = result.contents;
			if (typeof contents === "string") return contents;
			if (contents.value) return contents.value;
			if (Array.isArray(contents)) return contents.map((c: any) => typeof c === "string" ? c : c.value ?? "").join("\n");
			return JSON.stringify(contents);
		} catch (e) {
			return `LSP error: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	private guessLanguageId(filePath: string): string {
		const ext = extname(filePath).toLowerCase();
		const map: Record<string, string> = {
			".ts": "typescript", ".tsx": "typescriptreact",
			".js": "javascript", ".jsx": "javascriptreact",
			".py": "python", ".go": "go", ".rs": "rust",
			".css": "css", ".scss": "scss", ".html": "html",
			".json": "json", ".md": "markdown", ".yaml": "yaml",
			".yml": "yaml", ".toml": "toml", ".lua": "lua",
			".rb": "ruby", ".java": "java", ".kt": "kotlin",
			".swift": "swift", ".c": "c", ".cpp": "cpp",
			".cs": "csharp", ".sh": "shellscript",
		};
		return map[ext] ?? "plaintext";
	}

	getToolDefinition(): ToolDefinition {
		return {
			name: "LSP" as any,
			description: "Language Server Protocol operations: goToDefinition, hover, getDiagnostics. Provides real-time type errors and navigation.",
			input_schema: {
				type: "object",
				properties: {
					operation: {
						type: "string",
						enum: ["goToDefinition", "hover", "getDiagnostics"],
						description: "The LSP operation to perform",
					},
					filePath: { type: "string", description: "Absolute path to the file" },
					line: { type: "number", description: "1-based line number (for goToDefinition, hover)" },
					character: { type: "number", description: "1-based character position (for goToDefinition, hover)" },
				},
				required: ["operation", "filePath"],
			},
		};
	}

	closeAll(): void {
		for (const conn of this.connections.values()) {
			try { conn.proc.kill(); } catch { /* already dead */ }
		}
		this.connections.clear();
	}
}
