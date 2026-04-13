// Scheduled Tasks — cron-like scheduled agent runs
// Tasks persist in Convex and execute on a timer

import type { ScheduledTask } from '../types.js';

// ─── Cron Expression Parser (basic) ──────────────────────────────────────────

interface CronFields {
	readonly minute: number[];
	readonly hour: number[];
	readonly dayOfMonth: number[];
	readonly month: number[];
	readonly dayOfWeek: number[];
}

function parseCronField(field: string, min: number, max: number): number[] {
	if (field === '*') {
		return Array.from({ length: max - min + 1 }, (_, i) => min + i);
	}

	const values: number[] = [];

	for (const part of field.split(',')) {
		if (part.includes('/')) {
			const [range, stepStr] = part.split('/');
			const step = parseInt(stepStr, 10);
			const [start, end] = range === '*'
				? [min, max]
				: range.includes('-')
					? range.split('-').map(Number) as [number, number]
					: [parseInt(range, 10), max];

			for (let i = start; i <= end; i += step) {
				values.push(i);
			}
		} else if (part.includes('-')) {
			const [start, end] = part.split('-').map(Number);
			for (let i = start; i <= end; i++) {
				values.push(i);
			}
		} else {
			values.push(parseInt(part, 10));
		}
	}

	return values.filter((v) => v >= min && v <= max);
}

function parseCron(expression: string): CronFields {
	const parts = expression.trim().split(/\s+/);
	if (parts.length !== 5) {
		throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
	}

	return {
		minute: parseCronField(parts[0], 0, 59),
		hour: parseCronField(parts[1], 0, 23),
		dayOfMonth: parseCronField(parts[2], 1, 31),
		month: parseCronField(parts[3], 1, 12),
		dayOfWeek: parseCronField(parts[4], 0, 6),
	};
}

export function getNextRunTime(cronExpression: string, after: Date = new Date()): Date {
	const cron = parseCron(cronExpression);
	const next = new Date(after);
	next.setSeconds(0, 0);
	next.setMinutes(next.getMinutes() + 1);

	// Brute force search — find next matching minute within 366 days
	const limit = 366 * 24 * 60;
	for (let i = 0; i < limit; i++) {
		if (
			cron.minute.includes(next.getMinutes()) &&
			cron.hour.includes(next.getHours()) &&
			cron.dayOfMonth.includes(next.getDate()) &&
			cron.month.includes(next.getMonth() + 1) &&
			cron.dayOfWeek.includes(next.getDay())
		) {
			return next;
		}
		next.setMinutes(next.getMinutes() + 1);
	}

	throw new Error('Could not find next run time within 366 days');
}

export function describeCron(expression: string): string {
	const presets: Record<string, string> = {
		'* * * * *': 'Every minute',
		'*/5 * * * *': 'Every 5 minutes',
		'*/15 * * * *': 'Every 15 minutes',
		'*/30 * * * *': 'Every 30 minutes',
		'0 * * * *': 'Every hour',
		'0 */2 * * *': 'Every 2 hours',
		'0 */6 * * *': 'Every 6 hours',
		'0 0 * * *': 'Daily at midnight',
		'0 9 * * *': 'Daily at 9 AM',
		'0 9 * * 1-5': 'Weekdays at 9 AM',
		'0 0 * * 0': 'Weekly on Sunday',
		'0 0 1 * *': 'Monthly on the 1st',
	};

	return presets[expression] ?? expression;
}

// ─── Task Manager ────────────────────────────────────────────────────────────

// In-memory store (in production, use Convex)
const tasks: Map<string, ScheduledTask> = new Map();
const timers: Map<string, NodeJS.Timeout> = new Map();

export function createScheduledTask(task: Omit<ScheduledTask, 'nextRun'>): ScheduledTask {
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
	{ label: 'Every 5 minutes', cron: '*/5 * * * *' },
	{ label: 'Every 15 minutes', cron: '*/15 * * * *' },
	{ label: 'Every hour', cron: '0 * * * *' },
	{ label: 'Every 6 hours', cron: '0 */6 * * *' },
	{ label: 'Daily at 9 AM', cron: '0 9 * * *' },
	{ label: 'Weekdays at 9 AM', cron: '0 9 * * 1-5' },
	{ label: 'Weekly on Monday', cron: '0 9 * * 1' },
	{ label: 'Monthly on the 1st', cron: '0 0 1 * *' },
] as const;
