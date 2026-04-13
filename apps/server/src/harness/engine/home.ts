// Home Environment — root workspace + project folder routing
// When started from ~, the agent can create projects and move into them

import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { WorkspaceInfo } from '../types.js';

const PROJECT_DIRS = ['Projects', 'Developer', 'repos', 'workspace', 'code'];

export function getHomeDir(): string {
	return homedir();
}

export async function discoverProjects(): Promise<readonly WorkspaceInfo[]> {
	const home = homedir();
	const projects: WorkspaceInfo[] = [];

	// Add home itself
	projects.push({
		path: home,
		name: 'Home',
		isHome: true,
		lastAccessed: Date.now(),
	});

	// Scan known project directories
	for (const dir of PROJECT_DIRS) {
		const projectsPath = join(home, dir);
		try {
			const entries = await fs.readdir(projectsPath, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				if (entry.name.startsWith('.')) continue;

				const fullPath = join(projectsPath, entry.name);

				// Check if it's a git repo
				let gitRemote: string | undefined;
				try {
					const gitConfig = await fs.readFile(join(fullPath, '.git', 'config'), 'utf-8');
					const urlMatch = gitConfig.match(/url\s*=\s*(.+)/);
					if (urlMatch) gitRemote = urlMatch[1].trim();
				} catch {
					// Not a git repo, that's fine
				}

				const stat = await fs.stat(fullPath);
				projects.push({
					path: fullPath,
					name: entry.name,
					isHome: false,
					gitRemote,
					lastAccessed: stat.mtimeMs,
				});
			}
		} catch {
			// Directory doesn't exist
		}
	}

	// Sort by last accessed, most recent first
	return projects.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0));
}

export async function createProject(name: string): Promise<WorkspaceInfo> {
	const home = homedir();

	// Find the first existing project directory, or create Projects/
	let baseDir = join(home, 'Projects');
	for (const dir of PROJECT_DIRS) {
		const candidate = join(home, dir);
		try {
			await fs.stat(candidate);
			baseDir = candidate;
			break;
		} catch {
			continue;
		}
	}

	const projectPath = join(baseDir, name);
	await fs.mkdir(projectPath, { recursive: true });

	return {
		path: projectPath,
		name,
		isHome: false,
		lastAccessed: Date.now(),
	};
}
