import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      cron_expression TEXT NOT NULL,
      workspace_path TEXT NOT NULL,
      model TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_run INTEGER
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_enabled_created_at
    ON scheduled_tasks (enabled, created_at DESC)
  `;
});
