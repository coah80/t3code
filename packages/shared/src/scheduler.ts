function parseCronField(field: string, min: number, max: number): number[] {
  if (field === "*") {
    return Array.from({ length: max - min + 1 }, (_, index) => min + index);
  }

  const values: number[] = [];

  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [range = "*", stepText = "1"] = part.split("/");
      const step = Number.parseInt(stepText, 10);
      const [start, end] =
        range === "*"
          ? [min, max]
          : range.includes("-")
            ? (range.split("-").map(Number) as [number, number])
            : [Number.parseInt(range, 10), max];

      for (let value = start!; value <= end!; value += step) {
        values.push(value);
      }
      continue;
    }

    if (part.includes("-")) {
      const [start, end] = part.split("-").map(Number);
      for (let value = start!; value <= end!; value += 1) {
        values.push(value);
      }
      continue;
    }

    values.push(Number.parseInt(part, 10));
  }

  return values.filter((value) => value >= min && value <= max);
}

interface CronFields {
  readonly minute: number[];
  readonly hour: number[];
  readonly dayOfMonth: number[];
  readonly month: number[];
  readonly dayOfWeek: number[];
}

function parseCron(expression: string): CronFields {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
  }

  return {
    minute: parseCronField(parts[0]!, 0, 59),
    hour: parseCronField(parts[1]!, 0, 23),
    dayOfMonth: parseCronField(parts[2]!, 1, 31),
    month: parseCronField(parts[3]!, 1, 12),
    dayOfWeek: parseCronField(parts[4]!, 0, 6),
  };
}

export function getNextRunTime(cronExpression: string, after: Date = new Date()): Date {
  const cron = parseCron(cronExpression);
  const next = new Date(after);
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);

  const limit = 366 * 24 * 60;
  for (let index = 0; index < limit; index += 1) {
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

  throw new Error("Could not find next run time within 366 days");
}

export function describeCron(expression: string): string {
  const presets: Record<string, string> = {
    "* * * * *": "Every minute",
    "*/5 * * * *": "Every 5 minutes",
    "*/15 * * * *": "Every 15 minutes",
    "*/30 * * * *": "Every 30 minutes",
    "0 * * * *": "Every hour",
    "0 */2 * * *": "Every 2 hours",
    "0 */6 * * *": "Every 6 hours",
    "0 0 * * *": "Daily at midnight",
    "0 9 * * *": "Daily at 9 AM",
    "0 9 * * 1-5": "Weekdays at 9 AM",
    "0 0 * * 0": "Weekly on Sunday",
    "0 0 1 * *": "Monthly on the 1st",
  };

  return presets[expression] ?? expression;
}
