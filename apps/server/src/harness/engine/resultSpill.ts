// Tool Result Spilling — large outputs → temp file + preview
// Prevents context window blowout from massive tool outputs
// Inspired by Hermes Agent's 3-layer budget system

import { promises as fs } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const PER_RESULT_LIMIT = 50_000; // Chars per individual result
const PER_TURN_AGGREGATE_LIMIT = 200_000; // Total chars across all results in a turn
const PREVIEW_LINES = 30; // Lines to show in preview
const SPILL_DIR = join(tmpdir(), "coahcode-spill");

let spillCounter = 0;

async function ensureSpillDir(): Promise<void> {
  await fs.mkdir(SPILL_DIR, { recursive: true });
}

export interface SpilledResult {
  readonly preview: string;
  readonly spillPath: string;
  readonly originalLength: number;
}

function createPreview(content: string, maxLines: number): string {
  const lines = content.split("\n");
  if (lines.length <= maxLines * 2) return content;

  const head = lines.slice(0, maxLines).join("\n");
  const tail = lines.slice(-maxLines).join("\n");
  const omitted = lines.length - maxLines * 2;

  return `${head}\n\n... (${omitted} lines omitted, full output saved to file) ...\n\n${tail}`;
}

export async function spillIfNeeded(content: string, toolName: string): Promise<string> {
  if (content.length <= PER_RESULT_LIMIT) return content;

  await ensureSpillDir();
  spillCounter++;
  const filename = `spill_${Date.now()}_${spillCounter}_${toolName}.txt`;
  const spillPath = join(SPILL_DIR, filename);

  await fs.writeFile(spillPath, content, "utf-8");

  const preview = createPreview(content, PREVIEW_LINES);
  return (
    preview +
    `\n\n[Full output (${content.length.toLocaleString()} chars) saved to: ${spillPath}]\n` +
    `[Use the Read tool to access the full content if needed.]`
  );
}

export async function spillTurnResults(
  results: readonly { content: string; toolName: string }[],
): Promise<readonly string[]> {
  const totalChars = results.reduce((sum, r) => sum + r.content.length, 0);

  // If under aggregate limit, only spill individual oversize results
  if (totalChars <= PER_TURN_AGGREGATE_LIMIT) {
    return Promise.all(results.map((r) => spillIfNeeded(r.content, r.toolName)));
  }

  // Over aggregate limit — spill largest results first until under budget
  const indexed = results.map((r, i) => ({ ...r, index: i, length: r.content.length }));
  const sorted = indexed.toSorted((a, b) => b.length - a.length);

  const spilled = new Map<number, string>();
  let currentTotal = totalChars;

  for (const item of sorted) {
    if (currentTotal <= PER_TURN_AGGREGATE_LIMIT) break;

    await ensureSpillDir();
    spillCounter++;
    const filename = `spill_${Date.now()}_${spillCounter}_${item.toolName}.txt`;
    const spillPath = join(SPILL_DIR, filename);
    await fs.writeFile(spillPath, item.content, "utf-8");

    const preview = createPreview(item.content, 10);
    const spilledContent =
      preview + `\n\n[Full output (${item.length.toLocaleString()} chars) saved to: ${spillPath}]`;

    spilled.set(item.index, spilledContent);
    currentTotal -= item.length - spilledContent.length;
  }

  return results.map((r, i) => spilled.get(i) ?? r.content);
}

export async function cleanupSpillDir(): Promise<void> {
  try {
    const files = await fs.readdir(SPILL_DIR);
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;

    for (const file of files) {
      const filePath = join(SPILL_DIR, file);
      const stat = await fs.stat(filePath);
      if (now - stat.mtimeMs > ONE_HOUR) {
        await fs.unlink(filePath);
      }
    }
  } catch {
    /* dir might not exist */
  }
}
