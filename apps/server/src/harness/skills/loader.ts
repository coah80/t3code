// Skills Loader — discovers and loads SKILL.md files from standard locations
// Compatible with Claude Code, Cursor, and opencode skill formats

import { promises as fs } from "fs";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import type { ToolDefinition } from "../types.js";

export interface Skill {
	readonly name: string;
	readonly description: string;
	readonly content: string;
	readonly path: string;
	readonly source: "global" | "project" | "config";
}

// ─── YAML Frontmatter Parser (minimal) ───────────────────────────────────────

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return { meta: {}, body: content };

	const meta: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const colonIdx = line.indexOf(":");
		if (colonIdx > 0) {
			const key = line.slice(0, colonIdx).trim();
			const value = line.slice(colonIdx + 1).trim();
			meta[key] = value;
		}
	}

	return { meta, body: match[2] };
}

// ─── Instruction Files (AGENTS.md / CLAUDE.md) ──────────────────────────────

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"];

export async function loadInstructions(workspaceRoot: string): Promise<string[]> {
	const instructions: string[] = [];

	// Global instructions
	const globalPaths = [
		join(homedir(), ".config", "opencode", "AGENTS.md"),
		join(homedir(), ".claude", "CLAUDE.md"),
	];

	for (const p of globalPaths) {
		try {
			const content = await fs.readFile(p, "utf-8");
			if (content.trim()) instructions.push(content);
			break; // Only first global match
		} catch { /* not found */ }
	}

	// Walk up from workspace root looking for instruction files
	let dir = workspaceRoot;
	const root = "/";
	const visited = new Set<string>();

	while (dir !== root && !visited.has(dir)) {
		visited.add(dir);
		for (const filename of INSTRUCTION_FILES) {
			try {
				const content = await fs.readFile(join(dir, filename), "utf-8");
				if (content.trim()) {
					instructions.push(content);
					break; // First match per directory
				}
			} catch { /* not found */ }
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return instructions;
}

// ─── Skill Discovery ─────────────────────────────────────────────────────────

const SKILL_DIRS = [
	// Global
	{ base: () => join(homedir(), ".claude", "skills"), source: "global" as const },
	{ base: () => join(homedir(), ".cursor", "skills"), source: "global" as const },
	{ base: () => join(homedir(), ".agents", "skills"), source: "global" as const },
	{ base: () => join(homedir(), ".codex", "skills"), source: "global" as const },
];

async function findSkillFiles(dir: string, source: Skill["source"]): Promise<Skill[]> {
	const skills: Skill[] = [];

	try {
		const entries = await fs.readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const skillMd = join(dir, entry.name, "SKILL.md");
				try {
					const content = await fs.readFile(skillMd, "utf-8");
					const { meta, body } = parseFrontmatter(content);
					skills.push({
						name: meta.name ?? entry.name,
						description: meta.description ?? body.split("\n")[0].replace(/^#\s*/, ""),
						content: body,
						path: skillMd,
						source,
					});
				} catch { /* no SKILL.md */ }
			}
		}
	} catch { /* dir doesn't exist */ }

	return skills;
}

export async function discoverSkills(workspaceRoot: string): Promise<readonly Skill[]> {
	const allSkills: Skill[] = [];

	// Global skills
	for (const { base, source } of SKILL_DIRS) {
		const skills = await findSkillFiles(base(), source);
		allSkills.push(...skills);
	}

	// Project skills
	const projectSkillDirs = [
		join(workspaceRoot, ".cursor", "skills"),
		join(workspaceRoot, ".claude", "skills"),
		join(workspaceRoot, ".agents", "skills"),
	];

	for (const dir of projectSkillDirs) {
		const skills = await findSkillFiles(dir, "project");
		allSkills.push(...skills);
	}

	// Deduplicate by name (project wins over global)
	const seen = new Map<string, Skill>();
	for (const skill of allSkills) {
		const existing = seen.get(skill.name);
		if (!existing || (skill.source === "project" && existing.source === "global")) {
			seen.set(skill.name, skill);
		}
	}

	return [...seen.values()];
}

// ─── Skill Tool Definition ──────────────────────────────────────────────────

export function getSkillToolDefinition(skills: readonly Skill[]): ToolDefinition | null {
	if (skills.length === 0) return null;

	const skillList = skills
		.map((s) => `- ${s.name}: ${s.description}`)
		.join("\n");

	return {
		name: "Skill" as any,
		description: `Load a skill for specialized instructions. Available skills:\n${skillList}`,
		input_schema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					enum: skills.map((s) => s.name),
					description: "Name of the skill to load",
				},
			},
			required: ["name"],
		},
	};
}

export function getSkillContent(skills: readonly Skill[], name: string): string {
	const skill = skills.find((s) => s.name === name);
	if (!skill) return `Skill not found: ${name}`;
	return `<skill_content name="${skill.name}">\n${skill.content}\n</skill_content>`;
}
