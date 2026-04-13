import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Effect, Layer } from "effect";

import type {
  ScheduledTaskCreateInput,
  ScheduledTaskInfo,
  ScheduledTaskUpdateInput,
} from "@t3tools/contracts";
import {
  ScheduledTasksError,
  ScheduledTasksService,
  type ScheduledTasksShape,
} from "../Services/ScheduledTasks";

type ScheduledTaskRow = {
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly cronExpression: string;
  readonly workspacePath: string;
  readonly model: string;
  readonly enabled: number | boolean;
  readonly createdAt: number;
  readonly lastRun: number | null;
};

function toScheduledTask(row: ScheduledTaskRow): ScheduledTaskInfo {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    cronExpression: row.cronExpression,
    workspacePath: row.workspacePath,
    model: row.model,
    enabled: row.enabled === true || row.enabled === 1,
    createdAt: row.createdAt,
    ...(row.lastRun === null ? {} : { lastRun: row.lastRun }),
  };
}

const makeScheduledTasks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const mapError = (operation: string) => (cause: unknown) =>
    new ScheduledTasksError({
      operation,
      detail: cause instanceof Error ? cause.message : String(cause),
      cause,
    });

  const list: ScheduledTasksShape["list"] = sql<ScheduledTaskRow>`
    SELECT
      id AS "id",
      name AS "name",
      prompt AS "prompt",
      cron_expression AS "cronExpression",
      workspace_path AS "workspacePath",
      model AS "model",
      enabled AS "enabled",
      created_at AS "createdAt",
      last_run AS "lastRun"
    FROM scheduled_tasks
    ORDER BY created_at DESC, id DESC
  `.pipe(
    Effect.map((rows) => rows.map(toScheduledTask)),
    Effect.mapError(mapError("list")),
  );

  const create: ScheduledTasksShape["create"] = (input: ScheduledTaskCreateInput) =>
    Effect.gen(function* () {
      const createdAt = Date.now();
      const rows = yield* sql<ScheduledTaskRow>`
        INSERT INTO scheduled_tasks (
          id,
          name,
          prompt,
          cron_expression,
          workspace_path,
          model,
          enabled,
          created_at,
          updated_at,
          last_run
        )
        VALUES (
          ${crypto.randomUUID()},
          ${input.name},
          ${input.prompt},
          ${input.cronExpression},
          ${input.workspacePath},
          ${input.model},
          ${1},
          ${createdAt},
          ${createdAt},
          NULL
        )
        RETURNING
          id AS "id",
          name AS "name",
          prompt AS "prompt",
          cron_expression AS "cronExpression",
          workspace_path AS "workspacePath",
          model AS "model",
          enabled AS "enabled",
          created_at AS "createdAt",
          last_run AS "lastRun"
      `.pipe(Effect.mapError(mapError("create:query")));

      const row = rows[0];
      if (!row) {
        return yield* new ScheduledTasksError({
          operation: "create",
          detail: "Scheduled task insert did not return a row.",
        });
      }

      return toScheduledTask(row);
    });

  const update: ScheduledTasksShape["update"] = (input: ScheduledTaskUpdateInput) =>
    Effect.gen(function* () {
      const existingRows = yield* sql<ScheduledTaskRow>`
        SELECT
          id AS "id",
          name AS "name",
          prompt AS "prompt",
          cron_expression AS "cronExpression",
          workspace_path AS "workspacePath",
          model AS "model",
          enabled AS "enabled",
          created_at AS "createdAt",
          last_run AS "lastRun"
        FROM scheduled_tasks
        WHERE id = ${input.id}
        LIMIT 1
      `.pipe(Effect.mapError(mapError("update:select")));

      const existing = existingRows[0];
      if (!existing) {
        return null;
      }

      const resolvedEnabled =
        input.enabled ?? (existing.enabled === true || existing.enabled === 1);
      const updatedAt = Date.now();
      const rows = yield* sql<ScheduledTaskRow>`
        UPDATE scheduled_tasks
        SET
          name = ${input.name ?? existing.name},
          prompt = ${input.prompt ?? existing.prompt},
          cron_expression = ${input.cronExpression ?? existing.cronExpression},
          workspace_path = ${input.workspacePath ?? existing.workspacePath},
          model = ${input.model ?? existing.model},
          enabled = ${resolvedEnabled ? 1 : 0},
          updated_at = ${updatedAt}
        WHERE id = ${input.id}
        RETURNING
          id AS "id",
          name AS "name",
          prompt AS "prompt",
          cron_expression AS "cronExpression",
          workspace_path AS "workspacePath",
          model AS "model",
          enabled AS "enabled",
          created_at AS "createdAt",
          last_run AS "lastRun"
      `.pipe(Effect.mapError(mapError("update:query")));

      const row = rows[0];
      return row ? toScheduledTask(row) : null;
    });

  const remove: ScheduledTasksShape["remove"] = (id: string) =>
    sql<{ readonly id: string }>`
      DELETE FROM scheduled_tasks
      WHERE id = ${id}
      RETURNING id AS "id"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(mapError("remove")),
    );

  const markRun: ScheduledTasksShape["markRun"] = (id: string, runAt: number) =>
    sql<{ readonly id: string }>`
      UPDATE scheduled_tasks
      SET
        last_run = ${runAt},
        updated_at = ${runAt}
      WHERE id = ${id}
      RETURNING id AS "id"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(mapError("markRun")),
    );

  const toggle: ScheduledTasksShape["toggle"] = (id: string, enabled: boolean) =>
    sql<ScheduledTaskRow>`
      UPDATE scheduled_tasks
      SET
        enabled = ${enabled ? 1 : 0},
        updated_at = ${Date.now()}
      WHERE id = ${id}
      RETURNING
        id AS "id",
        name AS "name",
        prompt AS "prompt",
        cron_expression AS "cronExpression",
        workspace_path AS "workspacePath",
        model AS "model",
        enabled AS "enabled",
        created_at AS "createdAt",
        last_run AS "lastRun"
    `.pipe(
      Effect.map((rows) => {
        const row = rows[0];
        return row ? toScheduledTask(row) : null;
      }),
      Effect.mapError(mapError("toggle")),
    );

  return {
    list,
    create,
    update,
    markRun,
    remove,
    toggle,
  } satisfies ScheduledTasksShape;
});

export const ScheduledTasksLive = Layer.effect(ScheduledTasksService, makeScheduledTasks);
