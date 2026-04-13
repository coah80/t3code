import { Effect } from "effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas";
import {
  ClaudeModelOptions,
  CodexModelOptions,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  HarnessModelOptions,
} from "./model";
import { ModelSelection } from "./orchestration";

// ── Client Settings (local-only) ───────────────────────────────

export const TimestampFormat = Schema.Literals(["locale", "12-hour", "24-hour"]);
export type TimestampFormat = typeof TimestampFormat.Type;
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";

export const SidebarProjectSortOrder = Schema.Literals(["updated_at", "created_at", "manual"]);
export type SidebarProjectSortOrder = typeof SidebarProjectSortOrder.Type;
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER: SidebarProjectSortOrder = "updated_at";

export const SidebarThreadSortOrder = Schema.Literals(["updated_at", "created_at"]);
export type SidebarThreadSortOrder = typeof SidebarThreadSortOrder.Type;
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER: SidebarThreadSortOrder = "updated_at";

export const FollowUpBehavior = Schema.Literals(["steer", "queue"]);
export type FollowUpBehavior = typeof FollowUpBehavior.Type;
export const DEFAULT_FOLLOW_UP_BEHAVIOR: FollowUpBehavior = "queue";

export const ClientSettingsSchema = Schema.Struct({
  confirmThreadArchive: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  confirmThreadDelete: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  diffWordWrap: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  followUpBehavior: FollowUpBehavior.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_FOLLOW_UP_BEHAVIOR)),
  ),
  sidebarProjectSortOrder: SidebarProjectSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_PROJECT_SORT_ORDER)),
  ),
  sidebarThreadSortOrder: SidebarThreadSortOrder.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_SIDEBAR_THREAD_SORT_ORDER)),
  ),
  timestampFormat: TimestampFormat.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_TIMESTAMP_FORMAT)),
  ),
});
export type ClientSettings = typeof ClientSettingsSchema.Type;

export const DEFAULT_CLIENT_SETTINGS: ClientSettings = Schema.decodeSync(ClientSettingsSchema)({});

// ── Server Settings (server-authoritative) ────────────────────

export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;
export const AssistantHarnessMode = Schema.Literals(["native", "coahcode"]);
export type AssistantHarnessMode = typeof AssistantHarnessMode.Type;

const makeBinaryPathSetting = (fallback: string) =>
  TrimmedString.pipe(
    Schema.decodeTo(
      Schema.String,
      SchemaTransformation.transformOrFail({
        decode: (value) => Effect.succeed(value || fallback),
        encode: (value) => Effect.succeed(value),
      }),
    ),
    Schema.withDecodingDefault(Effect.succeed(fallback)),
  );

export const CodexSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  binaryPath: makeBinaryPathSetting("codex"),
  homePath: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type CodexSettings = typeof CodexSettings.Type;

export const ClaudeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  binaryPath: makeBinaryPathSetting("claude"),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type ClaudeSettings = typeof ClaudeSettings.Type;

export const HarnessMcpServerSettings = Schema.Struct({
  name: TrimmedNonEmptyString,
  type: Schema.Literals(["local", "remote"]),
  command: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
  url: Schema.optionalKey(TrimmedString),
  environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  timeout: Schema.optionalKey(Schema.Number),
});
export type HarnessMcpServerSettings = typeof HarnessMcpServerSettings.Type;

export const HarnessLspServerSettings = Schema.Struct({
  id: TrimmedNonEmptyString,
  extensions: Schema.Array(TrimmedNonEmptyString),
  command: Schema.Array(TrimmedNonEmptyString),
  rootMarkers: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type HarnessLspServerSettings = typeof HarnessLspServerSettings.Type;

export const HarnessSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  customModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  mcpServers: Schema.Array(HarnessMcpServerSettings).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  enableBuiltinLsp: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  lspServers: Schema.Array(HarnessLspServerSettings).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type HarnessSettings = typeof HarnessSettings.Type;

export const ObservabilitySettings = Schema.Struct({
  otlpTracesUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  otlpMetricsUrl: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type ObservabilitySettings = typeof ObservabilitySettings.Type;

export const ServerSettings = Schema.Struct({
  enableAssistantStreaming: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  assistantHarnessMode: AssistantHarnessMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("coahcode" as const satisfies AssistantHarnessMode)),
  ),
  defaultThreadEnvMode: ThreadEnvMode.pipe(
    Schema.withDecodingDefault(Effect.succeed("local" as const satisfies ThreadEnvMode)),
  ),
  textGenerationModelSelection: ModelSelection.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({
        provider: "codex" as const,
        model: DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.codex,
      }),
    ),
  ),

  // Provider specific settings
  providers: Schema.Struct({
    codex: CodexSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    harness: HarnessSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  observability: ObservabilitySettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type ServerSettings = typeof ServerSettings.Type;

export const DEFAULT_SERVER_SETTINGS: ServerSettings = Schema.decodeSync(ServerSettings)({});

export class ServerSettingsError extends Schema.TaggedErrorClass<ServerSettingsError>()(
  "ServerSettingsError",
  {
    settingsPath: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Server settings error at ${this.settingsPath}: ${this.detail}`;
  }
}

// ── Unified type ─────────────────────────────────────────────────────

export type UnifiedSettings = ServerSettings & ClientSettings;
export const DEFAULT_UNIFIED_SETTINGS: UnifiedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  ...DEFAULT_CLIENT_SETTINGS,
};

// ── Server Settings Patch (replace with a Schema.deepPartial if available) ──────────────────────────────────────────

const CodexModelOptionsPatch = Schema.Struct({
  reasoningEffort: Schema.optionalKey(CodexModelOptions.fields.reasoningEffort),
  fastMode: Schema.optionalKey(CodexModelOptions.fields.fastMode),
});

const ClaudeModelOptionsPatch = Schema.Struct({
  thinking: Schema.optionalKey(ClaudeModelOptions.fields.thinking),
  effort: Schema.optionalKey(ClaudeModelOptions.fields.effort),
  fastMode: Schema.optionalKey(ClaudeModelOptions.fields.fastMode),
  contextWindow: Schema.optionalKey(ClaudeModelOptions.fields.contextWindow),
});

const ModelSelectionPatch = Schema.Union([
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("codex")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(CodexModelOptionsPatch),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("claudeAgent")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(ClaudeModelOptionsPatch),
  }),
  Schema.Struct({
    provider: Schema.optionalKey(Schema.Literal("harness")),
    model: Schema.optionalKey(TrimmedNonEmptyString),
    options: Schema.optionalKey(HarnessModelOptions),
  }),
]);

const CodexSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  homePath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const ClaudeSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  binaryPath: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});

const HarnessSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
  mcpServers: Schema.optionalKey(Schema.Array(HarnessMcpServerSettings)),
  enableBuiltinLsp: Schema.optionalKey(Schema.Boolean),
  lspServers: Schema.optionalKey(Schema.Array(HarnessLspServerSettings)),
});

export const ServerSettingsPatch = Schema.Struct({
  enableAssistantStreaming: Schema.optionalKey(Schema.Boolean),
  assistantHarnessMode: Schema.optionalKey(AssistantHarnessMode),
  defaultThreadEnvMode: Schema.optionalKey(ThreadEnvMode),
  textGenerationModelSelection: Schema.optionalKey(ModelSelectionPatch),
  observability: Schema.optionalKey(
    Schema.Struct({
      otlpTracesUrl: Schema.optionalKey(Schema.String),
      otlpMetricsUrl: Schema.optionalKey(Schema.String),
    }),
  ),
  providers: Schema.optionalKey(
    Schema.Struct({
      codex: Schema.optionalKey(CodexSettingsPatch),
      claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
      harness: Schema.optionalKey(HarnessSettingsPatch),
    }),
  ),
});
export type ServerSettingsPatch = typeof ServerSettingsPatch.Type;
