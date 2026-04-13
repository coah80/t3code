import type { Effect } from "effect";
import { Context, Schema } from "effect";

import type {
  ScheduledTaskCreateInput,
  ScheduledTaskInfo,
  ScheduledTaskUpdateInput,
} from "@t3tools/contracts";

export class ScheduledTasksError extends Schema.TaggedErrorClass<ScheduledTasksError>()(
  "ScheduledTasksError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface ScheduledTasksShape {
  readonly list: Effect.Effect<ReadonlyArray<ScheduledTaskInfo>, ScheduledTasksError>;
  readonly create: (
    input: ScheduledTaskCreateInput,
  ) => Effect.Effect<ScheduledTaskInfo, ScheduledTasksError>;
  readonly update: (
    input: ScheduledTaskUpdateInput,
  ) => Effect.Effect<ScheduledTaskInfo | null, ScheduledTasksError>;
  readonly markRun: (id: string, runAt: number) => Effect.Effect<boolean, ScheduledTasksError>;
  readonly remove: (id: string) => Effect.Effect<boolean, ScheduledTasksError>;
  readonly toggle: (
    id: string,
    enabled: boolean,
  ) => Effect.Effect<ScheduledTaskInfo | null, ScheduledTasksError>;
}

export class ScheduledTasksService extends Context.Service<
  ScheduledTasksService,
  ScheduledTasksShape
>()("t3/scheduledTasks/Services/ScheduledTasksService") {}
