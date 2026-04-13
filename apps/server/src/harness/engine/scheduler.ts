// Scheduled Tasks — cron-like scheduled agent runs
// Tasks persist in Convex and execute on a timer

import type { ScheduledTask } from "../types";
import { describeCron, getNextRunTime } from "@t3tools/shared/scheduler";
export { describeCron, getNextRunTime } from "@t3tools/shared/scheduler";

// ─── Task Manager ────────────────────────────────────────────────────────────

// In-memory store (in production, use Convex)
const tasks: Map<string, ScheduledTask> = new Map();
const timers: Map<string, NodeJS.Timeout> = new Map();

export function createScheduledTask(task: Omit<ScheduledTask, "nextRun">): ScheduledTask {
  const nextRun = getNextRunTime(task.cronExpression).getTime();
  const fullTask: ScheduledTask = { ...task, nextRun };

  tasks.set(task.id, fullTask);

  if (task.enabled) {
    scheduleNext(task.id);
  }

  return fullTask;
}

export function listScheduledTasks(): readonly ScheduledTask[] {
  return [...tasks.values()];
}

export function deleteScheduledTask(id: string): boolean {
  const timer = timers.get(id);
  if (timer) {
    clearTimeout(timer);
    timers.delete(id);
  }
  return tasks.delete(id);
}

export function toggleScheduledTask(id: string, enabled: boolean): ScheduledTask | null {
  const task = tasks.get(id);
  if (!task) return null;

  const updated: ScheduledTask = { ...task, enabled };
  tasks.set(id, updated);

  if (enabled) {
    scheduleNext(id);
  } else {
    const timer = timers.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(id);
    }
  }

  return updated;
}

function scheduleNext(taskId: string): void {
  const task = tasks.get(taskId);
  if (!task || !task.enabled) return;

  const now = Date.now();
  const nextRun = getNextRunTime(task.cronExpression).getTime();
  const delay = Math.max(nextRun - now, 1000);

  // Clear existing timer
  const existing = timers.get(taskId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(async () => {
    await executeScheduledTask(taskId);
  }, delay);

  timers.set(taskId, timer);

  // Update nextRun
  tasks.set(taskId, { ...task, nextRun });
}

async function executeScheduledTask(taskId: string): Promise<void> {
  const task = tasks.get(taskId);
  if (!task || !task.enabled) return;

  console.log(`[Scheduler] Running task: ${task.name} (${task.id})`);

  // Update lastRun
  tasks.set(taskId, { ...task, lastRun: Date.now() });

  // The actual agent execution would happen here:
  // 1. Import runAgentLoop
  // 2. Create an AgentConfig from the task
  // 3. Run the loop with the task's prompt
  // 4. Store the result
  //
  // For now, we just log it. Wire this up when integrating:
  //
  // const { runAgentLoop } = await import('./loop.js');
  // const events = runAgentLoop({
  //   config: { model: task.model, provider: 'anthropic', apiKey: '...', mode: 'agent', workspaceRoot: task.workspacePath },
  //   userMessage: task.prompt,
  // });
  // let result = '';
  // for await (const event of events) {
  //   if (event.type === 'text_delta') result += event.text;
  // }
  // tasks.set(taskId, { ...task, lastResult: result, lastRun: Date.now() });

  // Schedule the next run
  scheduleNext(taskId);
}

// ─── Preset Schedules ────────────────────────────────────────────────────────

export const PRESET_SCHEDULES = [
  { label: "Every 5 minutes", cron: "*/5 * * * *" },
  { label: "Every 15 minutes", cron: "*/15 * * * *" },
  { label: "Every hour", cron: "0 * * * *" },
  { label: "Every 6 hours", cron: "0 */6 * * *" },
  { label: "Daily at 9 AM", cron: "0 9 * * *" },
  { label: "Weekdays at 9 AM", cron: "0 9 * * 1-5" },
  { label: "Weekly on Monday", cron: "0 9 * * 1" },
  { label: "Monthly on the 1st", cron: "0 0 1 * *" },
] as const;
