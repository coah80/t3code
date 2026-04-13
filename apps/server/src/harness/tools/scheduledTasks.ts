import type {
  ScheduledTaskCreateInput,
  ScheduledTaskInfo,
  ScheduledTaskUpdateInput,
} from "@t3tools/contracts";

import { getNextRunTime, describeCron } from "../engine/scheduler";
import type { AgentConfig, ToolDefinition } from "../types";

export interface AgentScheduledTaskManager {
  readonly list: () => Promise<ReadonlyArray<ScheduledTaskInfo>>;
  readonly create: (input: ScheduledTaskCreateInput) => Promise<ScheduledTaskInfo>;
  readonly update: (input: ScheduledTaskUpdateInput) => Promise<ScheduledTaskInfo | null>;
  readonly remove: (id: string) => Promise<boolean>;
  readonly toggle: (id: string, enabled: boolean) => Promise<ScheduledTaskInfo | null>;
}

const WEEKDAY_TO_CRON: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function normalizeWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function serializeHarnessModel(config: Pick<AgentConfig, "provider" | "model">): string {
  return `${config.provider}/${config.model}`;
}

function parseTimeValue(raw: string | undefined): { hour: number; minute: number } | null {
  if (!raw) {
    return null;
  }

  const match = raw
    .trim()
    .toLowerCase()
    .match(/^(?<hour>\d{1,2})(?::(?<minute>\d{2}))?\s*(?<meridiem>am|pm)?$/);
  if (!match?.groups?.hour) {
    return null;
  }

  let hour = Number.parseInt(match.groups.hour, 10);
  const minute = Number.parseInt(match.groups.minute ?? "0", 10);
  const meridiem = match.groups.meridiem;
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute < 0 || minute > 59) {
    return null;
  }

  if (meridiem === "am") {
    if (hour === 12) {
      hour = 0;
    }
  } else if (meridiem === "pm") {
    if (hour < 12) {
      hour += 12;
    }
  }

  if (hour < 0 || hour > 23) {
    return null;
  }

  return { hour, minute };
}

function normalizeNaturalLanguageSchedule(value: string): string {
  return normalizeWhitespace(value).toLowerCase();
}

function extractSchedulePhrase(value: string): string | null {
  const normalized = normalizeWhitespace(value);
  const patterns = [
    /\bevery\s+\d+\s+minutes?\b/i,
    /\bevery\s+\d+\s+hours?\b/i,
    /\bevery\s+minute\b/i,
    /\bevery\s+hour\b/i,
    /\bevery\s+day(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/i,
    /\bdaily(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/i,
    /\bevery\s+weekday(?:s)?(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/i,
    /\bweekdays(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/i,
    /\bweekly(?:\s+on\s+[a-z]+)?(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/i,
    /\bmonthly(?:\s+on\s+the\s+\d+(?:st|nd|rd|th)?)?(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/i,
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[0]) {
      return match[0];
    }
  }

  return null;
}

function naturalLanguageScheduleToCron(value: string): string | null {
  const normalized = normalizeNaturalLanguageSchedule(value);

  if (normalized === "every minute" || normalized === "every 1 minute") {
    return "* * * * *";
  }
  if (normalized === "every hour" || normalized === "hourly") {
    return "0 * * * *";
  }
  if (normalized === "daily" || normalized === "every day") {
    return "0 9 * * *";
  }
  if (normalized === "weekdays") {
    return "0 9 * * 1-5";
  }

  const everyMinutes = normalized.match(/^every\s+(\d+)\s+minutes?$/);
  if (everyMinutes?.[1]) {
    const interval = Number.parseInt(everyMinutes[1], 10);
    if (interval >= 1 && interval <= 59) {
      return interval === 1 ? "* * * * *" : `*/${interval} * * * *`;
    }
  }

  const everyHours = normalized.match(/^every\s+(\d+)\s+hours?$/);
  if (everyHours?.[1]) {
    const interval = Number.parseInt(everyHours[1], 10);
    if (interval >= 1 && interval <= 23) {
      return interval === 1 ? "0 * * * *" : `0 */${interval} * * *`;
    }
  }

  const dailyAt = normalized.match(/^daily(?:\s+at)?\s+(.+)$/);
  if (dailyAt?.[1]) {
    const parsedTime = parseTimeValue(dailyAt[1]);
    if (parsedTime) {
      return `${parsedTime.minute} ${parsedTime.hour} * * *`;
    }
  }

  const weekdaysAt = normalized.match(/^weekdays(?:\s+at)?\s+(.+)$/);
  if (weekdaysAt?.[1]) {
    const parsedTime = parseTimeValue(weekdaysAt[1]);
    if (parsedTime) {
      return `${parsedTime.minute} ${parsedTime.hour} * * 1-5`;
    }
  }

  const weeklyAt = normalized.match(/^weekly(?:\s+on\s+([a-z]+))?(?:\s+at\s+(.+))?$/);
  if (weeklyAt) {
    const weekday = weeklyAt[1]?.toLowerCase() ?? "monday";
    const parsedTime = parseTimeValue(weeklyAt[2] ?? "9am");
    const dayOfWeek = WEEKDAY_TO_CRON[weekday];
    if (parsedTime && dayOfWeek !== undefined) {
      return `${parsedTime.minute} ${parsedTime.hour} * * ${dayOfWeek}`;
    }
  }

  const monthlyAt = normalized.match(
    /^monthly(?:\s+on\s+the\s+(\d+)(?:st|nd|rd|th)?)?(?:\s+at\s+(.+))?$/,
  );
  if (monthlyAt) {
    const dayOfMonth = Number.parseInt(monthlyAt[1] ?? "1", 10);
    const parsedTime = parseTimeValue(monthlyAt[2] ?? "9am");
    if (parsedTime && dayOfMonth >= 1 && dayOfMonth <= 31) {
      return `${parsedTime.minute} ${parsedTime.hour} ${dayOfMonth} * *`;
    }
  }

  return null;
}

function cleanupScheduledPrompt(value: string): string {
  return normalizeWhitespace(value)
    .replace(
      /^(?:please\s+)?(?:make it so|set it up so|set this up so|set up|schedule(?:\s+it|\s+this)?(?:\s+to)?|create(?:\s+a)?\s+scheduled\s+task(?:\s+to)?|create(?:\s+a)?\s+task(?:\s+to)?|have the ai|have the agent)\s+/i,
      "",
    )
    .replace(/^(?:that|this|then)\s+/i, "")
    .replace(/^(?:you|it)\s+/i, "")
    .replace(/\s+[,.!?]+$/g, "")
    .trim();
}

function resolvePromptValue(args: Record<string, unknown>): string {
  const candidates = [args.prompt, args.request, args.instruction, args.task, args.message];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return "";
}

function resolveCronExpression(
  args: Record<string, unknown>,
  prompt: string,
): {
  readonly cronExpression: string;
  readonly prompt: string;
} {
  const cronExpression =
    typeof args.cron_expression === "string" ? normalizeWhitespace(args.cron_expression) : "";
  if (cronExpression.length > 0) {
    getNextRunTime(cronExpression);
    const schedulePhrase = extractSchedulePhrase(prompt);
    const cleanedPrompt = schedulePhrase
      ? cleanupScheduledPrompt(prompt.replace(schedulePhrase, " "))
      : cleanupScheduledPrompt(prompt);
    return {
      cronExpression,
      prompt: cleanedPrompt || prompt,
    };
  }

  const scheduleText =
    typeof args.schedule_text === "string" ? normalizeWhitespace(args.schedule_text) : "";
  if (scheduleText.length > 0) {
    const parsed = naturalLanguageScheduleToCron(scheduleText);
    if (!parsed) {
      throw new Error(
        `Could not translate schedule_text "${scheduleText}" into cron. Use a 5-field cron expression or a simple phrase like "every 5 minutes" or "daily at 9am".`,
      );
    }

    getNextRunTime(parsed);
    const schedulePhrase = extractSchedulePhrase(prompt);
    const cleanedPrompt = schedulePhrase
      ? cleanupScheduledPrompt(prompt.replace(schedulePhrase, " "))
      : cleanupScheduledPrompt(prompt);
    return {
      cronExpression: parsed,
      prompt: cleanedPrompt || prompt,
    };
  }

  const extractedScheduleText = extractSchedulePhrase(prompt);
  if (!extractedScheduleText) {
    throw new Error(
      'Provide either cron_expression or schedule_text. The tool can also infer a schedule from prompt text like "every 5 minutes".',
    );
  }

  const normalizedScheduleText = extractedScheduleText.replace(/^every\s+weekdays?/i, "weekdays");
  const parsed = naturalLanguageScheduleToCron(normalizedScheduleText);
  if (!parsed) {
    throw new Error(
      `Could not translate the schedule phrase "${extractedScheduleText}" into cron. Use a 5-field cron expression or a simple phrase like "every 5 minutes" or "daily at 9am".`,
    );
  }

  getNextRunTime(parsed);
  const cleanedPrompt = cleanupScheduledPrompt(prompt.replace(extractedScheduleText, " "));
  return {
    cronExpression: parsed,
    prompt: cleanedPrompt || prompt,
  };
}

function formatTask(task: ScheduledTaskInfo): string {
  const baseline = new Date(task.lastRun ?? task.createdAt ?? Date.now());
  let nextRun: string;
  try {
    nextRun = new Date(getNextRunTime(task.cronExpression, baseline)).toISOString();
  } catch {
    nextRun = "invalid cron";
  }

  return [
    `- ${task.name} [${task.enabled ? "enabled" : "disabled"}]`,
    `  id: ${task.id}`,
    `  schedule: ${describeCron(task.cronExpression)} (${task.cronExpression})`,
    `  model: ${task.model}`,
    `  workspace: ${task.workspacePath}`,
    `  next_run: ${nextRun}`,
  ].join("\n");
}

export function getScheduledTaskToolDefinition(): ToolDefinition {
  return {
    name: "ScheduledTask",
    description:
      "Create, list, delete, or toggle persistent scheduled agent tasks for the current workspace. Use this when the user asks you to monitor something, improve something on a recurring basis, run checks every N minutes, or automate repeated work in the background. Prefer action=create with a self-contained prompt and either cron_expression or schedule_text.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "create", "update", "delete", "toggle"],
          description: "Which scheduled-task action to perform.",
        },
        id: {
          type: "string",
          description: "Existing task id for delete or toggle.",
        },
        enabled: {
          type: "boolean",
          description: "Enable or disable an existing task when action=toggle.",
        },
        name: {
          type: "string",
          description: "Human-readable task name when action=create.",
        },
        prompt: {
          type: "string",
          description:
            'The self-contained prompt the scheduled agent should run each time. Include enough context that it can run without this chat history. If it already contains a phrase like "every 5 minutes", the tool can infer the schedule when schedule_text is omitted.',
        },
        cron_expression: {
          type: "string",
          description: "Standard 5-field cron expression, for example */5 * * * * or 0 9 * * 1-5.",
        },
        schedule_text: {
          type: "string",
          description:
            'Human-friendly recurring schedule, for example "every 5 minutes", "every hour", "daily at 9am", or "weekdays at 8:30am".',
        },
        workspace_path: {
          type: "string",
          description: "Workspace path to run the task in. Defaults to the current workspace.",
        },
        model: {
          type: "string",
          description:
            "Model slug to use for future runs, e.g. anthropic/claude-sonnet-4-6. Defaults to the current harness model.",
        },
      },
      required: ["action"],
    },
  };
}

export async function executeScheduledTaskTool(
  args: Record<string, unknown>,
  options: {
    readonly manager: AgentScheduledTaskManager;
    readonly config: AgentConfig;
  },
): Promise<string> {
  const { manager, config } = options;
  const action = typeof args.action === "string" ? args.action : "";

  switch (action) {
    case "list": {
      const tasks = await manager.list();
      if (tasks.length === 0) {
        return "No scheduled tasks found.";
      }
      return `Scheduled tasks:\n${tasks.map(formatTask).join("\n")}`;
    }
    case "create": {
      const rawPrompt = resolvePromptValue(args);
      if (rawPrompt.length === 0) {
        throw new Error("prompt is required when action=create.");
      }

      const { cronExpression, prompt } = resolveCronExpression(args, rawPrompt);
      const name =
        typeof args.name === "string" && args.name.trim().length > 0
          ? args.name.trim()
          : truncateTaskName(prompt);
      const workspacePath =
        typeof args.workspace_path === "string" && args.workspace_path.trim().length > 0
          ? args.workspace_path.trim()
          : config.workspaceRoot;
      const model =
        typeof args.model === "string" && args.model.trim().length > 0
          ? args.model.trim()
          : serializeHarnessModel(config);

      const task = await manager.create({
        name,
        prompt,
        cronExpression,
        workspacePath,
        model,
      });
      return [
        `Scheduled task created: ${task.name}`,
        `id: ${task.id}`,
        `schedule: ${describeCron(task.cronExpression)} (${task.cronExpression})`,
        `model: ${task.model}`,
        `workspace: ${task.workspacePath}`,
      ].join("\n");
    }
    case "update": {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (id.length === 0) {
        throw new Error("id is required when action=update.");
      }

      const rawPrompt = resolvePromptValue(args);
      const scheduleSpecified =
        typeof args.cron_expression === "string" ||
        typeof args.schedule_text === "string" ||
        (rawPrompt.length > 0 && extractSchedulePhrase(rawPrompt) !== null);
      const nextSchedule =
        rawPrompt.length > 0 && scheduleSpecified ? resolveCronExpression(args, rawPrompt) : null;

      const updated = await manager.update({
        id,
        ...(typeof args.name === "string" && args.name.trim().length > 0
          ? { name: args.name.trim() }
          : {}),
        ...(rawPrompt.length > 0
          ? { prompt: nextSchedule ? nextSchedule.prompt : rawPrompt.trim() }
          : {}),
        ...(nextSchedule ? { cronExpression: nextSchedule.cronExpression } : {}),
        ...(typeof args.workspace_path === "string" && args.workspace_path.trim().length > 0
          ? { workspacePath: args.workspace_path.trim() }
          : {}),
        ...(typeof args.model === "string" && args.model.trim().length > 0
          ? { model: args.model.trim() }
          : {}),
        ...(typeof args.enabled === "boolean" ? { enabled: args.enabled } : {}),
      });

      if (!updated) {
        return `Scheduled task ${id} was not found.`;
      }

      return [
        `Scheduled task updated: ${updated.name}`,
        `id: ${updated.id}`,
        `schedule: ${describeCron(updated.cronExpression)} (${updated.cronExpression})`,
        `model: ${updated.model}`,
        `workspace: ${updated.workspacePath}`,
      ].join("\n");
    }
    case "delete": {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (id.length === 0) {
        throw new Error("id is required when action=delete.");
      }
      const deleted = await manager.remove(id);
      return deleted ? `Deleted scheduled task ${id}.` : `Scheduled task ${id} was not found.`;
    }
    case "toggle": {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (id.length === 0) {
        throw new Error("id is required when action=toggle.");
      }
      if (typeof args.enabled !== "boolean") {
        throw new Error("enabled must be provided when action=toggle.");
      }
      const updated = await manager.toggle(id, args.enabled);
      if (!updated) {
        return `Scheduled task ${id} was not found.`;
      }
      return `Scheduled task ${updated.name} is now ${updated.enabled ? "enabled" : "disabled"}.`;
    }
    default:
      throw new Error(`Unknown ScheduledTask action: ${String(action)}`);
  }
}

function truncateTaskName(prompt: string): string {
  const normalized = normalizeWhitespace(prompt);
  if (normalized.length <= 72) {
    return normalized;
  }
  return `${normalized.slice(0, 69)}...`;
}
