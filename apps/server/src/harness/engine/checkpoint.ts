// Checkpoint Manager — transparent filesystem snapshots before file mutations
// Creates automatic git snapshots invisible to the LLM
// Provides rollback to any previous checkpoint

import { spawn } from "child_process";
import { promises as fs } from "fs";
import { join } from "path";
import { homedir } from "os";

const CHECKPOINT_BASE = join(homedir(), ".coahcode", "checkpoints");

export interface Checkpoint {
  readonly id: string;
  readonly timestamp: number;
  readonly description: string;
  readonly workspacePath: string;
  readonly hash: string;
}

async function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    proc.on("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args.join(" ")} failed: ${stderr}`));
    });
  });
}

export class CheckpointManager {
  private readonly checkpointDir: string;
  private initialized = false;

  constructor(private readonly workspacePath: string) {
    // Hash workspace path for unique checkpoint dir
    const pathHash = Buffer.from(workspacePath).toString("base64url").slice(0, 20);
    this.checkpointDir = join(CHECKPOINT_BASE, pathHash);
  }

  private async ensureInit(): Promise<void> {
    if (this.initialized) return;

    await fs.mkdir(this.checkpointDir, { recursive: true });

    // Check if already a git repo
    try {
      await runGit(["rev-parse", "--git-dir"], this.checkpointDir);
    } catch {
      // Initialize shadow git repo
      await runGit(["init"], this.checkpointDir);
      await runGit(["config", "user.name", "CoahCode Checkpoints"], this.checkpointDir);
      await runGit(["config", "user.email", "checkpoints@coahcode.local"], this.checkpointDir);
    }

    this.initialized = true;
  }

  async createCheckpoint(description: string, files: readonly string[]): Promise<Checkpoint> {
    await this.ensureInit();

    // Copy files to checkpoint dir
    for (const file of files) {
      try {
        const content = await fs.readFile(file, "utf-8");
        const relative = file.startsWith(this.workspacePath)
          ? file.slice(this.workspacePath.length + 1)
          : file;

        const destPath = join(this.checkpointDir, relative);
        const destDir = destPath.substring(0, destPath.lastIndexOf("/"));
        await fs.mkdir(destDir, { recursive: true });
        await fs.writeFile(destPath, content, "utf-8");
      } catch {
        // File might not exist yet (new file creation)
      }
    }

    // Commit
    try {
      await runGit(["add", "-A"], this.checkpointDir);
      await runGit(["commit", "-m", description, "--allow-empty"], this.checkpointDir);
    } catch {
      // Nothing to commit
    }

    const hash = await runGit(["rev-parse", "HEAD"], this.checkpointDir).catch(() => "unknown");

    return {
      id: `cp_${Date.now()}`,
      timestamp: Date.now(),
      description,
      workspacePath: this.workspacePath,
      hash,
    };
  }

  async listCheckpoints(limit = 20): Promise<readonly Checkpoint[]> {
    await this.ensureInit();

    try {
      const log = await runGit(
        ["log", `--max-count=${limit}`, "--format=%H|%at|%s"],
        this.checkpointDir,
      );

      return log
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [hash = "", timestamp = "0", ...descParts] = line.split("|");
          return {
            id: `cp_${timestamp}`,
            timestamp: parseInt(timestamp, 10) * 1000,
            description: descParts.join("|"),
            workspacePath: this.workspacePath,
            hash,
          };
        });
    } catch {
      return [];
    }
  }

  async rollback(hash: string): Promise<{ restoredFiles: readonly string[] }> {
    await this.ensureInit();

    // Get list of files at that commit
    const files = await runGit(["ls-tree", "-r", "--name-only", hash], this.checkpointDir);
    const fileList = files.split("\n").filter(Boolean);

    const restoredFiles: string[] = [];

    for (const relative of fileList) {
      try {
        const content = await runGit(["show", `${hash}:${relative}`], this.checkpointDir);
        const destPath = join(this.workspacePath, relative);
        const destDir = destPath.substring(0, destPath.lastIndexOf("/"));
        await fs.mkdir(destDir, { recursive: true });
        await fs.writeFile(destPath, content, "utf-8");
        restoredFiles.push(destPath);
      } catch {
        // File might have issues
      }
    }

    return { restoredFiles };
  }
}
