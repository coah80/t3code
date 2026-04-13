import {
  type ToolLifecycleItemType,
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  type ProviderRuntimeEvent,
  type ProviderSessionStartInput,
  type ProviderSession,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ScheduledTaskCreateInput,
  type ScheduledTaskUpdateInput,
} from "@t3tools/contracts";
import { Effect, Layer, Queue, Stream } from "effect";

import { runAgentLoop } from "../../harness/engine/loop.ts";
import type { AgentScheduledTaskManager } from "../../harness/tools/scheduledTasks";
import type { ConversationMessage, ToolCall, ToolResult } from "../../harness/types.ts";
import { ServerSettingsService } from "../../serverSettings";
import { ScheduledTasksService } from "../../scheduledTasks/Services/ScheduledTasks";
import {
  createHarnessLspManager,
  parseHarnessModel,
  resolveHarnessMcpConfigs,
  resolveHarnessUpstreamAuth,
} from "./harnessRuntime.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { HarnessAdapter, type HarnessAdapterShape } from "../Services/HarnessAdapter.ts";

const PROVIDER = "harness" as const;
const SUPPORTED_RUNTIME_MODES = new Set(["full-access", "auto-accept-edits"]);

type HarnessConversationTurn = {
  readonly id: TurnId;
  readonly userInput: string;
  readonly assistantText: string;
  readonly items: ReadonlyArray<unknown>;
};

type HarnessResumeCursor = {
  readonly model?: string;
  readonly turns?: ReadonlyArray<{
    readonly id: string;
    readonly userInput: string;
    readonly assistantText: string;
  }>;
};

interface HarnessPendingTurn {
  readonly turnId: TurnId;
  readonly startedAt: string;
  readonly userInput: string;
  readonly assistantItemId: RuntimeItemId;
  readonly toolItemIds: Map<string, RuntimeItemId>;
  readonly items: Array<unknown>;
  assistantText: string;
  abortRequested: boolean;
}

interface HarnessSessionContext {
  session: ProviderSession;
  turns: Array<HarnessConversationTurn>;
  pendingTurn: HarnessPendingTurn | undefined;
  runAbortController: AbortController | undefined;
  runPromise: Promise<void> | undefined;
  stopped: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeEventId(): EventId {
  return EventId.make(crypto.randomUUID());
}

function requireSession(
  sessions: Map<ThreadId, HarnessSessionContext>,
  threadId: ThreadId,
): HarnessSessionContext {
  const context = sessions.get(threadId);
  if (!context) {
    throw new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }
  if (context.stopped || context.session.status === "closed") {
    throw new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
    });
  }
  return context;
}

function isHarnessModelSelection(
  value: unknown,
): value is Extract<
  NonNullable<ProviderSessionStartInput["modelSelection"]>,
  { provider: "harness" }
> {
  return (
    !!value &&
    typeof value === "object" &&
    "provider" in value &&
    (value as { provider?: unknown }).provider === PROVIDER &&
    "model" in value &&
    typeof (value as { model?: unknown }).model === "string" &&
    (value as { model: string }).model.trim().length > 0
  );
}

function normalizeModelSelection(input: {
  readonly modelSelection?: unknown;
  readonly fallbackModel: string | undefined;
}): string {
  if (isHarnessModelSelection(input.modelSelection)) {
    return input.modelSelection.model.trim();
  }
  return input.fallbackModel?.trim() || DEFAULT_MODEL_BY_PROVIDER.harness;
}

function conversationHistoryFromTurns(
  turns: ReadonlyArray<HarnessConversationTurn>,
): ConversationMessage[] {
  return turns.flatMap((turn) => [
    { role: "user" as const, content: turn.userInput },
    { role: "assistant" as const, content: turn.assistantText },
  ]);
}

function serializeResumeCursor(context: HarnessSessionContext): HarnessResumeCursor {
  return {
    ...(context.session.model ? { model: context.session.model } : {}),
    turns: context.turns.map((turn) => ({
      id: turn.id,
      userInput: turn.userInput,
      assistantText: turn.assistantText,
    })),
  };
}

function parseResumeCursor(value: unknown): HarnessResumeCursor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const cursor = value as Record<string, unknown>;
  const turns = Array.isArray(cursor.turns)
    ? cursor.turns
        .filter(
          (entry): entry is { id: string; userInput: string; assistantText: string } =>
            !!entry &&
            typeof entry === "object" &&
            typeof (entry as Record<string, unknown>).id === "string" &&
            typeof (entry as Record<string, unknown>).userInput === "string" &&
            typeof (entry as Record<string, unknown>).assistantText === "string",
        )
        .map((entry) => ({
          id: entry.id,
          userInput: entry.userInput,
          assistantText: entry.assistantText,
        }))
    : undefined;

  return {
    ...(typeof cursor.model === "string" && cursor.model.trim().length > 0
      ? { model: cursor.model.trim() }
      : {}),
    ...(turns ? { turns } : {}),
  };
}

function summarizeToolCall(toolCall: ToolCall): string | undefined {
  const { arguments: args } = toolCall;
  return [
    typeof args.command === "string" ? args.command : undefined,
    typeof args.path === "string" ? args.path : undefined,
    typeof args.pattern === "string" ? args.pattern : undefined,
    typeof args.query === "string" ? args.query : undefined,
    typeof args.name === "string" ? args.name : undefined,
  ]
    .find((value): value is string => !!value && value.trim().length > 0)
    ?.slice(0, 180);
}

function summarizeToolResult(result: ToolResult): string | undefined {
  const trimmed = result.content.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > 180 ? `${trimmed.slice(0, 177)}...` : trimmed;
}

function mapToolItemType(toolName: string): ToolLifecycleItemType {
  if (toolName === "Shell") return "command_execution";
  if (toolName === "Write" || toolName === "StrReplace" || toolName === "Delete") {
    return "file_change";
  }
  if (toolName === "WebSearch") return "web_search";
  if (toolName.startsWith("mcp_")) return "mcp_tool_call";
  return "dynamic_tool_call";
}

function formatToolTitle(toolName: string): string {
  if (!toolName.startsWith("mcp_")) {
    return toolName;
  }
  const parts = toolName.split("_");
  if (parts.length < 3) {
    return toolName;
  }
  return `${parts[1]} · ${parts.slice(2).join("_")}`;
}

const makeHarnessAdapter = Effect.gen(function* () {
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const runtimeContext = yield* Effect.context<never>();
  const runPromise = Effect.runPromiseWith(runtimeContext);
  const serverSettings = yield* ServerSettingsService;
  const scheduledTasks = yield* ScheduledTasksService;
  const sessions = new Map<ThreadId, HarnessSessionContext>();
  const scheduledTaskManager = {
    list: () => runPromise(scheduledTasks.list),
    create: (input: ScheduledTaskCreateInput) => runPromise(scheduledTasks.create(input)),
    update: (input: ScheduledTaskUpdateInput) => runPromise(scheduledTasks.update(input)),
    remove: (id: string) => runPromise(scheduledTasks.remove(id)),
    toggle: (id: string, enabled: boolean) => runPromise(scheduledTasks.toggle(id, enabled)),
  } satisfies AgentScheduledTaskManager;

  const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
    runPromise(Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid));

  const runtimeEventBase = (context: HarnessSessionContext) => ({
    eventId: makeEventId(),
    provider: PROVIDER,
    threadId: context.session.threadId,
    createdAt: nowIso(),
  });

  const emitSessionLifecycle = async (context: HarnessSessionContext): Promise<void> => {
    await offerRuntimeEvent({
      ...runtimeEventBase(context),
      type: "session.started",
      payload: context.session.resumeCursor ? { resume: context.session.resumeCursor } : {},
    } satisfies ProviderRuntimeEvent);
    await offerRuntimeEvent({
      ...runtimeEventBase(context),
      type: "session.configured",
      payload: {
        config: {
          cwd: context.session.cwd ?? null,
          model: context.session.model ?? null,
          runtimeMode: context.session.runtimeMode,
        },
      },
    } satisfies ProviderRuntimeEvent);
    await offerRuntimeEvent({
      ...runtimeEventBase(context),
      type: "thread.started",
      payload: {},
    } satisfies ProviderRuntimeEvent);
    await offerRuntimeEvent({
      ...runtimeEventBase(context),
      type: "session.state.changed",
      payload: {
        state: "ready",
      },
    } satisfies ProviderRuntimeEvent);
  };

  const finalizeTurn = async (
    context: HarnessSessionContext,
    options: {
      readonly state: "completed" | "failed" | "interrupted";
      readonly errorMessage?: string;
    },
  ): Promise<void> => {
    const pendingTurn = context.pendingTurn;
    if (!pendingTurn) {
      return;
    }

    await offerRuntimeEvent({
      ...runtimeEventBase(context),
      type: "item.completed",
      turnId: pendingTurn.turnId,
      itemId: pendingTurn.assistantItemId,
      payload: {
        itemType: "assistant_message",
        status: options.state === "failed" ? "failed" : "completed",
        title: "Assistant message",
        ...(pendingTurn.assistantText.trim().length > 0
          ? { detail: pendingTurn.assistantText.trim().slice(0, 4_000) }
          : {}),
      },
    } satisfies ProviderRuntimeEvent);

    context.turns.push({
      id: pendingTurn.turnId,
      userInput: pendingTurn.userInput,
      assistantText: pendingTurn.assistantText,
      items: [...pendingTurn.items],
    });
    const {
      activeTurnId: _ignoredActiveTurnId,
      lastError: _ignoredLastError,
      ...sessionBase
    } = context.session;
    context.session = {
      ...sessionBase,
      status: options.state === "failed" ? "error" : "ready",
      updatedAt: nowIso(),
      resumeCursor: serializeResumeCursor(context),
      ...(options.errorMessage ? { lastError: options.errorMessage } : {}),
    };

    await offerRuntimeEvent({
      ...runtimeEventBase(context),
      type: "turn.completed",
      turnId: pendingTurn.turnId,
      payload: {
        state: options.state,
        ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
      },
    } satisfies ProviderRuntimeEvent);

    context.pendingTurn = undefined;
    context.runAbortController = undefined;
    context.runPromise = undefined;
  };

  const stopSessionInternal = async (
    context: HarnessSessionContext,
    options?: { readonly emitExitEvent?: boolean },
  ): Promise<void> => {
    context.stopped = true;
    context.runAbortController?.abort();
    context.runAbortController = undefined;
    context.runPromise = undefined;
    context.pendingTurn = undefined;
    const { activeTurnId: _ignoredActiveTurnId, ...sessionBase } = context.session;
    context.session = {
      ...sessionBase,
      status: "closed",
      updatedAt: nowIso(),
    };
    sessions.delete(context.session.threadId);

    if (options?.emitExitEvent !== false) {
      await offerRuntimeEvent({
        ...runtimeEventBase(context),
        type: "session.exited",
        payload: {
          exitKind: "graceful",
        },
      } satisfies ProviderRuntimeEvent);
    }
  };

  const startSession: HarnessAdapterShape["startSession"] = Effect.fn("startSession")(
    function* (input) {
      if (input.provider !== undefined && input.provider !== PROVIDER) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
        });
      }

      if (!SUPPORTED_RUNTIME_MODES.has(input.runtimeMode)) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue:
            "CoahCode Harness currently supports only full-access and auto-accept-edits runtime modes.",
        });
      }

      const resumed = parseResumeCursor(input.resumeCursor);
      const restoredTurns =
        resumed?.turns?.map((turn) => ({
          id: TurnId.make(turn.id),
          userInput: turn.userInput,
          assistantText: turn.assistantText,
          items: [],
        })) ?? [];
      const startedAt = nowIso();
      const model = normalizeModelSelection({
        modelSelection: input.modelSelection,
        fallbackModel: resumed?.model,
      });

      const session: ProviderSession = {
        provider: PROVIDER,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(model ? { model } : {}),
        threadId: input.threadId,
        resumeCursor: {
          ...(model ? { model } : {}),
          turns: restoredTurns.map((turn) => ({
            id: turn.id,
            userInput: turn.userInput,
            assistantText: turn.assistantText,
          })),
        },
        createdAt: startedAt,
        updatedAt: startedAt,
      };

      const context: HarnessSessionContext = {
        session,
        turns: [...restoredTurns],
        pendingTurn: undefined,
        runAbortController: undefined,
        runPromise: undefined,
        stopped: false,
      };
      sessions.set(input.threadId, context);

      yield* Effect.tryPromise({
        try: () => emitSessionLifecycle(context),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/start",
            detail: `Failed to emit harness session lifecycle: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      });

      return { ...session };
    },
  );

  const sendTurn: HarnessAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    const context = yield* Effect.try({
      try: () => requireSession(sessions, input.threadId),
      catch: (cause) => cause as ProviderAdapterError,
    });

    if (input.attachments && input.attachments.length > 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "CoahCode Harness does not support chat attachments yet.",
      });
    }

    if (input.modelSelection !== undefined && input.modelSelection.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: `Expected model selection provider '${PROVIDER}' but received '${input.modelSelection.provider}'.`,
      });
    }

    if (context.pendingTurn || context.runPromise) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Thread '${input.threadId}' already has an active harness turn.`,
      });
    }

    const selectedModel = normalizeModelSelection({
      modelSelection: input.modelSelection,
      fallbackModel: context.session.model,
    });
    const parsedModel = parseHarnessModel(selectedModel);
    const workspaceRoot = context.session.cwd ?? process.cwd();
    const upstreamAuth = yield* Effect.tryPromise({
      try: () =>
        resolveHarnessUpstreamAuth({
          workspaceRoot,
          upstream: parsedModel.upstream,
        }),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: `Failed to resolve harness auth: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    });
    if (!upstreamAuth) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Missing API key for harness upstream '${parsedModel.upstream}'.`,
      });
    }
    const harnessSettings = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.providers.harness),
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "turn/start",
            detail: `Failed to load harness settings: ${cause.message}`,
            cause,
          }),
      ),
    );
    const mcpConfigs = yield* Effect.tryPromise({
      try: () =>
        resolveHarnessMcpConfigs({
          workspaceRoot,
          servers: harnessSettings.mcpServers,
        }),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: `Failed to resolve harness MCP settings: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    });
    const lspManager = createHarnessLspManager(harnessSettings);

    const turnId = TurnId.make(crypto.randomUUID());
    const assistantItemId = RuntimeItemId.make(`assistant:${turnId}`);
    const userInput = input.input?.trim() ?? "";
    const startedAt = nowIso();

    context.pendingTurn = {
      turnId,
      startedAt,
      userInput,
      assistantItemId,
      toolItemIds: new Map(),
      items: [],
      assistantText: "",
      abortRequested: false,
    };
    context.runAbortController = new AbortController();
    context.session = {
      ...context.session,
      status: "running",
      model: selectedModel,
      activeTurnId: turnId,
      updatedAt: startedAt,
    };

    yield* Effect.tryPromise({
      try: () =>
        offerRuntimeEvent({
          ...runtimeEventBase(context),
          type: "turn.started",
          turnId,
          itemId: assistantItemId,
          payload: {
            model: selectedModel,
          },
        } satisfies ProviderRuntimeEvent),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "turn/start",
          detail: `Failed to emit harness turn start: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    });

    const conversationHistory = conversationHistoryFromTurns(context.turns);
    const turnWorker = (async () => {
      try {
        for await (const event of runAgentLoop({
          config: {
            model: parsedModel.model,
            provider: parsedModel.upstream,
            apiKey: upstreamAuth.apiKey,
            ...(upstreamAuth.baseURL ? { baseURL: upstreamAuth.baseURL } : {}),
            mode: input.interactionMode === "plan" ? "plan" : "agent",
            workspaceRoot,
          },
          userMessage: userInput,
          conversationHistory,
          signal: context.runAbortController?.signal,
          ...(mcpConfigs.length > 0 ? { mcpConfigs } : {}),
          ...(lspManager ? { lspManager } : {}),
          scheduledTaskManager,
        })) {
          const activeTurn = context.pendingTurn;
          if (!activeTurn || activeTurn.turnId !== turnId) {
            return;
          }

          switch (event.type) {
            case "text_delta":
              activeTurn.assistantText += event.text;
              await offerRuntimeEvent({
                ...runtimeEventBase(context),
                type: "content.delta",
                turnId,
                itemId: assistantItemId,
                payload: {
                  streamKind: "assistant_text",
                  delta: event.text,
                },
              } satisfies ProviderRuntimeEvent);
              break;
            case "thinking_delta":
              await offerRuntimeEvent({
                ...runtimeEventBase(context),
                type: "content.delta",
                turnId,
                itemId: assistantItemId,
                payload: {
                  streamKind: "reasoning_text",
                  delta: event.text,
                },
              } satisfies ProviderRuntimeEvent);
              break;
            case "tool_call_start": {
              const itemId = RuntimeItemId.make(`tool:${turnId}:${event.toolCall.id}`);
              activeTurn.toolItemIds.set(event.toolCall.id, itemId);
              activeTurn.items.push({
                type: "tool_call_start",
                toolCall: event.toolCall,
              });
              await offerRuntimeEvent({
                ...runtimeEventBase(context),
                type: "item.started",
                turnId,
                itemId,
                payload: {
                  itemType: mapToolItemType(event.toolCall.name),
                  title: formatToolTitle(event.toolCall.name),
                  ...(summarizeToolCall(event.toolCall)
                    ? { detail: summarizeToolCall(event.toolCall) }
                    : {}),
                },
              } satisfies ProviderRuntimeEvent);
              break;
            }
            case "tool_call_complete": {
              const itemId =
                activeTurn.toolItemIds.get(event.toolCallId) ??
                RuntimeItemId.make(`tool:${turnId}:${event.toolCallId}`);
              activeTurn.items.push({
                type: "tool_call_complete",
                toolCallId: event.toolCallId,
                result: event.result,
              });
              await offerRuntimeEvent({
                ...runtimeEventBase(context),
                type: "item.completed",
                turnId,
                itemId,
                payload: {
                  itemType: mapToolItemType(
                    (
                      activeTurn.items.find(
                        (item) =>
                          item &&
                          typeof item === "object" &&
                          "type" in item &&
                          (item as { type?: unknown }).type === "tool_call_start" &&
                          (item as { toolCall?: ToolCall }).toolCall?.id === event.toolCallId,
                      ) as { toolCall?: ToolCall } | undefined
                    )?.toolCall?.name ?? "Skill",
                  ),
                  status: event.result.is_error ? "failed" : "completed",
                  title: formatToolTitle(
                    (
                      activeTurn.items.find(
                        (item) =>
                          item &&
                          typeof item === "object" &&
                          "type" in item &&
                          (item as { type?: unknown }).type === "tool_call_start" &&
                          (item as { toolCall?: ToolCall }).toolCall?.id === event.toolCallId,
                      ) as { toolCall?: ToolCall } | undefined
                    )?.toolCall?.name ?? "Skill",
                  ),
                  ...(summarizeToolResult(event.result)
                    ? { detail: summarizeToolResult(event.result) }
                    : {}),
                  data: {
                    toolCallId: event.toolCallId,
                  },
                },
              } satisfies ProviderRuntimeEvent);
              break;
            }
            case "turn_complete":
              activeTurn.items.push({
                type: "turn_complete",
                turn: event.turn,
              });
              break;
            case "agent_complete":
              await finalizeTurn(context, { state: "completed" });
              return;
            case "error": {
              const interrupted =
                activeTurn.abortRequested ||
                event.error.toLowerCase().includes("aborted by user") ||
                event.error.toLowerCase().includes("abort");
              if (!interrupted) {
                await offerRuntimeEvent({
                  ...runtimeEventBase(context),
                  type: "runtime.error",
                  turnId,
                  payload: {
                    message: event.error,
                    class: "provider_error",
                  },
                } satisfies ProviderRuntimeEvent);
              }
              await finalizeTurn(context, {
                state: interrupted ? "interrupted" : "failed",
                ...(interrupted ? {} : { errorMessage: event.error }),
              });
              return;
            }
            case "commentary":
              break;
          }
        }

        if (context.pendingTurn?.turnId === turnId) {
          await finalizeTurn(context, { state: "completed" });
        }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (context.pendingTurn?.turnId === turnId) {
          await offerRuntimeEvent({
            ...runtimeEventBase(context),
            type: "runtime.error",
            turnId,
            payload: {
              message,
              class: "provider_error",
            },
          } satisfies ProviderRuntimeEvent);
          await finalizeTurn(context, { state: "failed", errorMessage: message });
        }
      } finally {
        lspManager?.closeAll();
      }
    })();

    context.runPromise = turnWorker;

    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: serializeResumeCursor(context),
    };
  });

  const interruptTurn: HarnessAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
    function* (threadId, _turnId) {
      const context = yield* Effect.try({
        try: () => requireSession(sessions, threadId),
        catch: (cause) => cause as ProviderAdapterError,
      });
      if (context.pendingTurn) {
        context.pendingTurn.abortRequested = true;
      }
      context.runAbortController?.abort();
    },
  );

  const readThread: HarnessAdapterShape["readThread"] = Effect.fn("readThread")(
    function* (threadId) {
      const context = yield* Effect.try({
        try: () => requireSession(sessions, threadId),
        catch: (cause) => cause as ProviderAdapterError,
      });
      return {
        threadId,
        turns: context.turns.map((turn) => ({
          id: turn.id,
          items: [...turn.items],
        })),
      };
    },
  );

  const rollbackThread: HarnessAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
    function* (threadId, numTurns) {
      if (!Number.isInteger(numTurns) || numTurns < 1) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        });
      }

      const context = yield* Effect.try({
        try: () => requireSession(sessions, threadId),
        catch: (cause) => cause as ProviderAdapterError,
      });

      const nextLength = Math.max(0, context.turns.length - numTurns);
      context.turns.splice(nextLength);
      context.session = {
        ...context.session,
        resumeCursor: serializeResumeCursor(context),
        updatedAt: nowIso(),
      };

      return {
        threadId,
        turns: context.turns.map((turn) => ({
          id: turn.id,
          items: [...turn.items],
        })),
      };
    },
  );

  const respondToRequest: HarnessAdapterShape["respondToRequest"] = (
    threadId,
    _requestId,
    _decision,
  ) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/requestApproval/decision",
        detail: `Thread '${threadId}' has no pending approval requests.`,
      }),
    );

  const respondToUserInput: HarnessAdapterShape["respondToUserInput"] = (
    threadId,
    _requestId,
    _answers,
  ) =>
    Effect.fail(
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/tool/respondToUserInput",
        detail: `Thread '${threadId}' has no pending user-input requests.`,
      }),
    );

  const stopSession: HarnessAdapterShape["stopSession"] = Effect.fn("stopSession")(
    function* (threadId) {
      const context = yield* Effect.try({
        try: () => requireSession(sessions, threadId),
        catch: (cause) => cause as ProviderAdapterError,
      });
      yield* Effect.tryPromise({
        try: () => stopSessionInternal(context),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/stop",
            detail: `Failed to stop harness session: ${cause instanceof Error ? cause.message : String(cause)}`,
            cause,
          }),
      });
    },
  );

  const listSessions: HarnessAdapterShape["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), ({ session }) => ({ ...session })));

  const hasSession: HarnessAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const stopAll: HarnessAdapterShape["stopAll"] = () =>
    Effect.tryPromise({
      try: () =>
        Promise.all(Array.from(sessions.values()).map((context) => stopSessionInternal(context))),
      catch: (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "session/stopAll",
          detail: `Failed to stop harness sessions: ${cause instanceof Error ? cause.message : String(cause)}`,
          cause,
        }),
    }).pipe(Effect.asVoid);

  yield* Effect.addFinalizer(() =>
    stopAll().pipe(Effect.orDie, Effect.andThen(Queue.shutdown(runtimeEventQueue))),
  );

  return {
    provider: PROVIDER,
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    readThread,
    rollbackThread,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies HarnessAdapterShape;
});

export const HarnessAdapterLive = Layer.effect(HarnessAdapter, makeHarnessAdapter);

export function makeHarnessAdapterLive() {
  return Layer.effect(HarnessAdapter, makeHarnessAdapter);
}
