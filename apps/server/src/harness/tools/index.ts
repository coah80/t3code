// Tool implementations — local execution of agent tools
// Each tool executes on the server (SvelteKit) and returns results to the agent loop

import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import { join, resolve, isAbsolute } from 'path';
// @ts-expect-error -- glob types may not be installed
import { glob } from 'glob';
import type { ToolCall, ToolResult, ToolDefinition } from '../types';

// ─── Tool Registry ───────────────────────────────────────────────────────────

const toolHandlers: Record<string, (args: Record<string, unknown>, workspaceRoot: string) => Promise<string>> = {
	Shell: executeShell,
	Read: executeRead,
	Write: executeWrite,
	StrReplace: executeStrReplace,
	Delete: executeDelete,
	Glob: executeGlob,
	Grep: executeGrep,
	ReadLints: executeReadLints,
	TodoWrite: executeTodoWrite,
	WebSearch: executeWebSearch,
	WebFetch: executeWebFetch,
};

export async function executeTool(call: ToolCall, workspaceRoot: string): Promise<ToolResult> {
	const handler = toolHandlers[call.name];
	if (!handler) {
		return {
			tool_call_id: call.id,
			content: `Unknown tool: ${call.name}`,
			is_error: true,
		};
	}

	try {
		const content = await handler(call.arguments, workspaceRoot);
		return { tool_call_id: call.id, content };
	} catch (error) {
		return {
			tool_call_id: call.id,
			content: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
			is_error: true,
		};
	}
}

export async function executeToolsParallel(
	calls: readonly ToolCall[],
	workspaceRoot: string
): Promise<readonly ToolResult[]> {
	return Promise.all(calls.map((call) => executeTool(call, workspaceRoot)));
}

// ─── Path Resolution ─────────────────────────────────────────────────────────

function resolvePath(p: string, workspaceRoot: string): string {
	if (isAbsolute(p)) return p;
	return resolve(workspaceRoot, p);
}

function validatePath(p: string, workspaceRoot: string): string {
	const resolved = resolvePath(p, workspaceRoot);
	// Prevent path traversal outside workspace (basic check)
	if (!resolved.startsWith(workspaceRoot) && !resolved.startsWith('/tmp')) {
		throw new Error(`Path ${resolved} is outside workspace ${workspaceRoot}`);
	}
	return resolved;
}

// ─── Shell ───────────────────────────────────────────────────────────────────

async function executeShell(args: Record<string, unknown>, workspaceRoot: string): Promise<string> {
	const command = args.command as string;
	if (!command) throw new Error('command is required');

	const cwd = args.working_directory
		? resolvePath(args.working_directory as string, workspaceRoot)
		: workspaceRoot;

	const blockUntilMs = (args.block_until_ms as number) ?? 30000;

	return new Promise((resolve) => {
		const proc = spawn('bash', ['-c', command], {
			cwd,
			env: { ...process.env, TERM: 'dumb' },
			timeout: blockUntilMs > 0 ? blockUntilMs : undefined,
		});

		let stdout = '';
		let stderr = '';

		proc.stdout.on('data', (data) => { stdout += data.toString(); });
		proc.stderr.on('data', (data) => { stderr += data.toString(); });

		const timer = blockUntilMs > 0
			? setTimeout(() => {
				resolve(`[Command running in background]\nstdout so far:\n${stdout}\nstderr so far:\n${stderr}`);
			}, blockUntilMs)
			: null;

		proc.on('close', (code) => {
			if (timer) clearTimeout(timer);
			const output = stdout + (stderr ? `\nstderr:\n${stderr}` : '');
			const truncated = output.length > 50000 ? output.slice(0, 50000) + '\n... (truncated)' : output;
			resolve(code === 0 ? truncated : `Exit code: ${code}\n${truncated}`);
		});

		proc.on('error', (err) => {
			if (timer) clearTimeout(timer);
			resolve(`Command failed: ${err.message}`);
		});
	});
}

// ─── Read ────────────────────────────────────────────────────────────────────

async function executeRead(args: Record<string, unknown>, workspaceRoot: string): Promise<string> {
	const filePath = args.path as string;
	if (!filePath) throw new Error('path is required');

	const resolved = resolvePath(filePath, workspaceRoot);

	try {
		const stat = await fs.stat(resolved);

		// Image files — return base64
		if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(resolved)) {
			const data = await fs.readFile(resolved);
			const ext = resolved.split('.').pop()?.toLowerCase() ?? 'png';
			const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
			return `[Image: ${resolved} (${stat.size} bytes, ${mime})]`;
		}

		const content = await fs.readFile(resolved, 'utf-8');
		const lines = content.split('\n');
		const offset = (args.offset as number) ?? 0;
		const limit = (args.limit as number) ?? 2000;

		const slice = lines.slice(offset, offset + limit);
		const numbered = slice.map((line, i) => {
			const lineNum = String(offset + i + 1).padStart(6);
			const truncatedLine = line.length > 2000 ? line.slice(0, 2000) + '...' : line;
			return `${lineNum}\t${truncatedLine}`;
		});

		return numbered.join('\n');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return `File not found: ${resolved}`;
		}
		throw error;
	}
}

// ─── Write ───────────────────────────────────────────────────────────────────

async function executeWrite(args: Record<string, unknown>, workspaceRoot: string): Promise<string> {
	const filePath = args.path as string;
	const contents = args.contents as string;
	if (!filePath) throw new Error('path is required');
	if (contents === undefined) throw new Error('contents is required');

	const resolved = resolvePath(filePath, workspaceRoot);

	// Ensure parent directory exists
	const dir = resolved.substring(0, resolved.lastIndexOf('/'));
	await fs.mkdir(dir, { recursive: true });

	await fs.writeFile(resolved, contents, 'utf-8');
	return `File written: ${resolved} (${contents.length} chars)`;
}

// ─── StrReplace ──────────────────────────────────────────────────────────────

async function executeStrReplace(args: Record<string, unknown>, workspaceRoot: string): Promise<string> {
	const filePath = args.path as string;
	const oldStr = args.old_string as string;
	const newStr = args.new_string as string;
	const replaceAll = args.replace_all as boolean ?? false;

	if (!filePath) throw new Error('path is required');
	if (oldStr === undefined) throw new Error('old_string is required');
	if (newStr === undefined) throw new Error('new_string is required');
	if (oldStr === newStr) throw new Error('old_string and new_string must be different');

	const resolved = resolvePath(filePath, workspaceRoot);
	const content = await fs.readFile(resolved, 'utf-8');

	if (!content.includes(oldStr)) {
		throw new Error(`old_string not found in ${resolved}`);
	}

	const occurrences = content.split(oldStr).length - 1;
	if (occurrences > 1 && !replaceAll) {
		throw new Error(`old_string found ${occurrences} times. Use replace_all=true or provide more context.`);
	}

	const updated = replaceAll
		? content.split(oldStr).join(newStr)
		: content.replace(oldStr, newStr);

	await fs.writeFile(resolved, updated, 'utf-8');
	return `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${resolved}`;
}

// ─── Delete ──────────────────────────────────────────────────────────────────

async function executeDelete(args: Record<string, unknown>, workspaceRoot: string): Promise<string> {
	const filePath = args.path as string;
	if (!filePath) throw new Error('path is required');

	const resolved = validatePath(filePath, workspaceRoot);

	try {
		await fs.unlink(resolved);
		return `Deleted: ${resolved}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return `File not found: ${resolved}`;
		}
		throw error;
	}
}

// ─── Glob ────────────────────────────────────────────────────────────────────

async function executeGlob(args: Record<string, unknown>, workspaceRoot: string): Promise<string> {
	const pattern = args.glob_pattern as string;
	if (!pattern) throw new Error('glob_pattern is required');

	const targetDir = args.target_directory
		? resolvePath(args.target_directory as string, workspaceRoot)
		: workspaceRoot;

	const fullPattern = pattern.startsWith('**/')
		? pattern
		: `**/${pattern}`;

	const matches = await glob(fullPattern, {
		cwd: targetDir,
		nodir: true,
		ignore: ['**/node_modules/**', '**/.git/**'],
		maxDepth: 20,
	});

	if (matches.length === 0) {
		return 'No files found matching pattern.';
	}

	const sorted = matches.sort();
	const limited = sorted.slice(0, 500);
	const result = limited.map((m: string) => join(targetDir, m)).join('\n');

	return limited.length < sorted.length
		? `${result}\n\n... and ${sorted.length - limited.length} more files`
		: result;
}

// ─── Grep ────────────────────────────────────────────────────────────────────

async function executeGrep(args: Record<string, unknown>, workspaceRoot: string): Promise<string> {
	const pattern = args.pattern as string;
	if (!pattern) throw new Error('pattern is required');

	const searchPath = args.path
		? resolvePath(args.path as string, workspaceRoot)
		: workspaceRoot;

	const rgArgs = ['--color=never', '--no-heading', '--line-number'];

	// Output mode
	const outputMode = (args.output_mode as string) ?? 'content';
	if (outputMode === 'files_with_matches') rgArgs.push('--files-with-matches');
	else if (outputMode === 'count') rgArgs.push('--count');

	// Context
	if (args['-B']) rgArgs.push('-B', String(args['-B']));
	if (args['-A']) rgArgs.push('-A', String(args['-A']));
	if (args['-C']) rgArgs.push('-C', String(args['-C']));

	// Flags
	if (args['-i']) rgArgs.push('-i');
	if (args.multiline) rgArgs.push('-U', '--multiline-dotall');
	if (args.glob) rgArgs.push('--glob', args.glob as string);
	if (args.type) rgArgs.push('--type', args.type as string);

	// Head limit
	const headLimit = (args.head_limit as number) ?? 250;
	rgArgs.push('--max-count', String(headLimit));

	rgArgs.push('--', pattern, searchPath);

	return new Promise((resolve) => {
		const proc = spawn('rg', rgArgs, { cwd: workspaceRoot, timeout: 30000 });
		let output = '';
		proc.stdout.on('data', (d) => { output += d.toString(); });
		proc.stderr.on('data', (d) => { output += d.toString(); });
		proc.on('close', () => {
			resolve(output.length > 50000 ? output.slice(0, 50000) + '\n... (truncated)' : output || 'No matches found.');
		});
		proc.on('error', () => resolve('ripgrep (rg) not found. Install with: brew install ripgrep'));
	});
}

// ─── ReadLints ───────────────────────────────────────────────────────────────

async function executeReadLints(args: Record<string, unknown>, _workspaceRoot: string): Promise<string> {
	// Placeholder — in a real implementation this would query the LSP/diagnostic API
	const paths = args.paths as string[] ?? [];
	return `Linter diagnostics for ${paths.length ? paths.join(', ') : 'workspace'}: (no linter connected — integrate with ESLint/TSC for real diagnostics)`;
}

// ─── TodoWrite ───────────────────────────────────────────────────────────────

// In-memory todo state (per-session; in production use Convex)
const sessionTodos: Map<string, Array<{ id: string; content: string; status: string }>> = new Map();

async function executeTodoWrite(args: Record<string, unknown>, _workspaceRoot: string): Promise<string> {
	const merge = args.merge as boolean ?? false;
	const todos = args.todos as Array<{ id: string; content: string; status: string }>;

	if (!todos || !Array.isArray(todos)) throw new Error('todos array is required');

	const sessionKey = 'default'; // In production, key by conversation/session

	if (!merge) {
		sessionTodos.set(sessionKey, [...todos]);
	} else {
		const existing = sessionTodos.get(sessionKey) ?? [];
		for (const todo of todos) {
			const idx = existing.findIndex((t) => t.id === todo.id);
			if (idx >= 0) {
				existing[idx] = { ...existing[idx], ...todo };
			} else {
				existing.push(todo);
			}
		}
		sessionTodos.set(sessionKey, existing);
	}

	const current = sessionTodos.get(sessionKey) ?? [];
	const lines = current.map((t) => {
		const icon = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]';
		return `${icon} ${t.id}: ${t.content}`;
	});

	return `Todos updated:\n${lines.join('\n')}`;
}

// ─── WebSearch ───────────────────────────────────────────────────────────────

async function executeWebSearch(args: Record<string, unknown>, _workspaceRoot: string): Promise<string> {
	const query = args.search_term as string;
	if (!query) throw new Error('search_term is required');

	// Use DuckDuckGo lite as a free search fallback
	try {
		const resp = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
			headers: { 'User-Agent': 'Mozilla/5.0' },
		});
		const html = await resp.text();
		// Extract text snippets from the HTML
		const snippets = html
			.replace(/<[^>]+>/g, ' ')
			.replace(/\s+/g, ' ')
			.trim()
			.slice(0, 3000);
		return `Web search results for "${query}":\n${snippets}`;
	} catch {
		return `Web search failed for "${query}". Consider using a search API (Serper, Brave, etc.)`;
	}
}

// ─── WebFetch ────────────────────────────────────────────────────────────────

async function executeWebFetch(args: Record<string, unknown>, _workspaceRoot: string): Promise<string> {
	const url = args.url as string;
	if (!url) throw new Error('url is required');

	try {
		const resp = await fetch(url, {
			headers: { 'User-Agent': 'Mozilla/5.0' },
			signal: AbortSignal.timeout(15000),
		});
		const html = await resp.text();
		// Basic HTML to text extraction
		const text = html
			.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
			.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
			.replace(/<[^>]+>/g, '\n')
			.replace(/\n{3,}/g, '\n\n')
			.trim()
			.slice(0, 10000);
		return `Content from ${url}:\n${text}`;
	} catch (error) {
		return `Failed to fetch ${url}: ${error instanceof Error ? error.message : String(error)}`;
	}
}

// ─── Tool Definitions ────────────────────────────────────────────────────────

export function getToolDefinitions(): readonly ToolDefinition[] {
	// Return the tool definitions in the format expected by model providers
	return TOOL_DEFINITIONS;
}

const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
	{
		name: 'Shell',
		description: 'Execute a shell command in the workspace. Use for git, npm, build commands, etc.',
		input_schema: {
			type: 'object',
			properties: {
				command: { type: 'string', description: 'The command to execute' },
				working_directory: { type: 'string', description: 'Absolute path to working directory (defaults to workspace root)' },
				description: { type: 'string', description: 'Brief description of what this command does (5-10 words)' },
				block_until_ms: { type: 'number', description: 'How long to wait for completion in ms (default 30000). Set 0 for background.' },
			},
			required: ['command'],
		},
	},
	{
		name: 'Read',
		description: 'Read a file from the filesystem. Returns content with line numbers. Can read images.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Absolute path to the file to read' },
				offset: { type: 'integer', description: 'Line number to start reading from' },
				limit: { type: 'integer', description: 'Number of lines to read' },
			},
			required: ['path'],
		},
	},
	{
		name: 'Write',
		description: 'Write or create a file. Overwrites existing content.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Absolute path to the file' },
				contents: { type: 'string', description: 'Content to write' },
			},
			required: ['path', 'contents'],
		},
	},
	{
		name: 'StrReplace',
		description: 'Replace exact string in a file. Use replace_all for multiple occurrences.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Absolute path to the file' },
				old_string: { type: 'string', description: 'Text to replace' },
				new_string: { type: 'string', description: 'Replacement text' },
				replace_all: { type: 'boolean', description: 'Replace all occurrences (default false)' },
			},
			required: ['path', 'old_string', 'new_string'],
		},
	},
	{
		name: 'Delete',
		description: 'Delete a file at the specified path.',
		input_schema: {
			type: 'object',
			properties: {
				path: { type: 'string', description: 'Absolute path to the file to delete' },
			},
			required: ['path'],
		},
	},
	{
		name: 'Glob',
		description: 'Find files by glob pattern. Returns matching paths sorted by modification time.',
		input_schema: {
			type: 'object',
			properties: {
				glob_pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts")' },
				target_directory: { type: 'string', description: 'Directory to search in (defaults to workspace)' },
			},
			required: ['glob_pattern'],
		},
	},
	{
		name: 'Grep',
		description: 'Search file contents with regex using ripgrep.',
		input_schema: {
			type: 'object',
			properties: {
				pattern: { type: 'string', description: 'Regex pattern to search for' },
				path: { type: 'string', description: 'File or directory to search in' },
				glob: { type: 'string', description: 'Glob filter (e.g. "*.ts")' },
				output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] },
				'-B': { type: 'number', description: 'Lines before match' },
				'-A': { type: 'number', description: 'Lines after match' },
				'-C': { type: 'number', description: 'Context lines' },
				'-i': { type: 'boolean', description: 'Case insensitive' },
				type: { type: 'string', description: 'File type (e.g. "ts", "py")' },
				head_limit: { type: 'number', description: 'Max results' },
				multiline: { type: 'boolean', description: 'Enable multiline matching' },
			},
			required: ['pattern'],
		},
	},
	{
		name: 'ReadLints',
		description: 'Read linter errors for files in the workspace.',
		input_schema: {
			type: 'object',
			properties: {
				paths: { type: 'array', items: { type: 'string' }, description: 'File or directory paths' },
			},
		},
	},
	{
		name: 'TodoWrite',
		description: 'Create and manage a task list for complex multi-step work.',
		input_schema: {
			type: 'object',
			properties: {
				merge: { type: 'boolean', description: 'Merge with existing todos (true) or replace (false)' },
				todos: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string' },
							content: { type: 'string' },
							status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'cancelled'] },
						},
						required: ['id', 'content', 'status'],
					},
				},
			},
			required: ['merge', 'todos'],
		},
	},
	{
		name: 'WebSearch',
		description: 'Search the web for real-time information.',
		input_schema: {
			type: 'object',
			properties: {
				search_term: { type: 'string', description: 'Search query' },
				explanation: { type: 'string', description: 'Why this search is needed' },
			},
			required: ['search_term'],
		},
	},
	{
		name: 'WebFetch',
		description: 'Fetch and extract content from a URL.',
		input_schema: {
			type: 'object',
			properties: {
				url: { type: 'string', description: 'URL to fetch' },
			},
			required: ['url'],
		},
	},
	{
		name: 'AskQuestion',
		description: 'Ask the user a question with optional multiple-choice answers.',
		input_schema: {
			type: 'object',
			properties: {
				title: { type: 'string' },
				questions: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							id: { type: 'string' },
							prompt: { type: 'string' },
							options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } } } },
						},
						required: ['id', 'prompt'],
					},
				},
			},
			required: ['questions'],
		},
	},
	{
		name: 'SwitchMode',
		description: 'Switch between Agent mode (full tools) and Plan mode (read-only planning).',
		input_schema: {
			type: 'object',
			properties: {
				target_mode_id: { type: 'string', description: "Target mode: 'agent' or 'plan'" },
				explanation: { type: 'string', description: 'Why switching modes' },
			},
			required: ['target_mode_id'],
		},
	},
];
