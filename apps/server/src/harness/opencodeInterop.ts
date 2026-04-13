import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import { Schema } from "effect";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { glob } from "glob";

import type { McpServerConfig } from "./mcp/client";

export type OpencodeInteropProvider = "anthropic" | "openai" | "openrouter";

interface LoadedConfigSource {
  readonly path: string;
  readonly config: OpencodeInteropConfig;
}

interface OpencodeProviderOptions {
  readonly apiKey?: string | undefined;
  readonly baseURL?: string | undefined;
}

interface OpencodeInteropConfig {
  readonly mcp?: Readonly<Record<string, OpencodeMcpConfig>> | undefined;
  readonly provider?: Readonly<Record<string, OpencodeProviderConfig>> | undefined;
  readonly skills?: {
    readonly paths?: ReadonlyArray<string> | undefined;
  };
  readonly instructions?: ReadonlyArray<string> | undefined;
}

type OpencodeMcpConfig =
  | {
      readonly type: "local";
      readonly command: ReadonlyArray<string>;
      readonly environment?: Readonly<Record<string, string>> | undefined;
      readonly enabled?: boolean | undefined;
      readonly timeout?: number | undefined;
    }
  | {
      readonly type: "remote";
      readonly url: string;
      readonly headers?: Readonly<Record<string, string>> | undefined;
      readonly enabled?: boolean | undefined;
      readonly timeout?: number | undefined;
    };

interface OpencodeProviderConfig {
  readonly options?: OpencodeProviderOptions | undefined;
}

interface ResolvedInstructionPattern {
  readonly baseDir: string;
  readonly pattern: string;
}

export interface ResolvedOpencodeInterop {
  readonly mcpServers: ReadonlyArray<McpServerConfig>;
  readonly skillDirectories: ReadonlyArray<string>;
  readonly instructionPatterns: ReadonlyArray<ResolvedInstructionPattern>;
  readonly providerOptions: Partial<
    Readonly<Record<OpencodeInteropProvider, OpencodeProviderOptions>>
  >;
}

const decodeLenientUnknown = Schema.decodeUnknownSync(fromLenientJson(Schema.Unknown));

const OpencodeMcpLocalSchema = Schema.Struct({
  type: Schema.Literal("local"),
  command: Schema.Array(Schema.String),
  environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.optionalKey(Schema.Boolean),
  timeout: Schema.optionalKey(Schema.Number),
});

const OpencodeMcpRemoteSchema = Schema.Struct({
  type: Schema.Literal("remote"),
  url: Schema.String,
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  enabled: Schema.optionalKey(Schema.Boolean),
  timeout: Schema.optionalKey(Schema.Number),
});

const OpencodeProviderOptionsSchema = Schema.Struct({
  apiKey: Schema.optionalKey(Schema.String),
  baseURL: Schema.optionalKey(Schema.String),
});

const OpencodeProviderConfigSchema = Schema.Struct({
  options: Schema.optionalKey(OpencodeProviderOptionsSchema),
});

const OpencodeInteropConfigSchema = Schema.Struct({
  mcp: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Union([OpencodeMcpLocalSchema, OpencodeMcpRemoteSchema])),
  ),
  provider: Schema.optionalKey(Schema.Record(Schema.String, OpencodeProviderConfigSchema)),
  skills: Schema.optionalKey(
    Schema.Struct({
      paths: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  instructions: Schema.optionalKey(Schema.Array(Schema.String)),
});

const decodeInteropConfig = Schema.decodeUnknownSync(OpencodeInteropConfigSchema);

function trimOrUndefined(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function expandHomePath(pathValue: string): string {
  if (pathValue === "~") {
    return homedir();
  }
  if (pathValue.startsWith("~/")) {
    return join(homedir(), pathValue.slice(2));
  }
  return pathValue;
}

function resolveConfigPath(pathValue: string, baseDir: string): string {
  const expanded = expandHomePath(pathValue);
  return isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
}

async function resolveTemplateValue(value: unknown, baseDir: string): Promise<unknown> {
  if (typeof value === "string") {
    const envExpanded = value.replace(/\{env:([^}]+)\}/g, (_match, key: string) => {
      return process.env[key.trim()] ?? "";
    });

    const fileMatches = [...envExpanded.matchAll(/\{file:([^}]+)\}/g)];
    if (fileMatches.length === 0) {
      return envExpanded;
    }

    let resolvedValue = envExpanded;
    for (const match of fileMatches) {
      const placeholder = match[0];
      const rawPath = match[1]?.trim();
      if (!rawPath) {
        resolvedValue = resolvedValue.replace(placeholder, "");
        continue;
      }

      const filePath = resolveConfigPath(rawPath, baseDir);
      const fileContents = await fs.readFile(filePath, "utf8").catch(() => "");
      resolvedValue = resolvedValue.replace(placeholder, fileContents);
    }
    return resolvedValue;
  }

  if (Array.isArray(value)) {
    return await Promise.all(value.map((entry) => resolveTemplateValue(entry, baseDir)));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  const entries = await Promise.all(
    Object.entries(value).map(
      async ([key, entry]) => [key, await resolveTemplateValue(entry, baseDir)] as const,
    ),
  );
  return Object.fromEntries(entries);
}

async function loadConfigFile(filePath: string): Promise<LoadedConfigSource | null> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  try {
    const parsed = decodeLenientUnknown(raw);
    const resolved = await resolveTemplateValue(parsed, dirname(filePath));
    return {
      path: filePath,
      config: decodeInteropConfig(resolved),
    };
  } catch {
    return null;
  }
}

function candidateConfigFiles(workspaceRoot: string): ReadonlyArray<string> {
  const globalDir = join(homedir(), ".config", "opencode");
  const projectDir = workspaceRoot;
  const projectInteropDir = join(workspaceRoot, ".opencode");
  const customConfigDir = trimOrUndefined(process.env.OPENCODE_CONFIG_DIR);
  const customConfigPath = trimOrUndefined(process.env.OPENCODE_CONFIG);

  const candidates = [
    join(globalDir, "opencode.jsonc"),
    join(globalDir, "opencode.json"),
    join(globalDir, "config.json"),
    customConfigPath ? resolve(customConfigPath) : null,
    join(projectDir, "opencode.jsonc"),
    join(projectDir, "opencode.json"),
    join(projectInteropDir, "opencode.jsonc"),
    join(projectInteropDir, "opencode.json"),
    ...(customConfigDir
      ? [
          join(resolve(customConfigDir), "opencode.jsonc"),
          join(resolve(customConfigDir), "opencode.json"),
        ]
      : []),
  ].filter((value): value is string => Boolean(value));

  return [...new Set(candidates)];
}

function mergeProviderOptions(
  previous: OpencodeProviderOptions | undefined,
  next: OpencodeProviderOptions | undefined,
): OpencodeProviderOptions | undefined {
  if (!previous && !next) {
    return undefined;
  }
  return {
    ...previous,
    ...next,
  };
}

function providerNames(): ReadonlyArray<OpencodeInteropProvider> {
  return ["anthropic", "openai", "openrouter"];
}

export async function loadOpencodeInterop(workspaceRoot: string): Promise<ResolvedOpencodeInterop> {
  const loadedConfigs = (
    await Promise.all(
      candidateConfigFiles(workspaceRoot).map((filePath) => loadConfigFile(filePath)),
    )
  ).filter((entry): entry is LoadedConfigSource => entry !== null);

  const mcpByName = new Map<string, McpServerConfig>();
  const skillDirectories = new Set<string>();
  const instructionPatterns: ResolvedInstructionPattern[] = [];
  const providerOptions: Partial<Record<OpencodeInteropProvider, OpencodeProviderOptions>> = {};

  const customConfigDir = trimOrUndefined(process.env.OPENCODE_CONFIG_DIR);
  if (customConfigDir) {
    const resolvedDir = resolve(customConfigDir);
    skillDirectories.add(join(resolvedDir, "skills"));
    skillDirectories.add(join(resolvedDir, "skill"));
  }

  for (const loaded of loadedConfigs) {
    const baseDir = dirname(loaded.path);

    for (const provider of providerNames()) {
      const merged = mergeProviderOptions(
        providerOptions[provider],
        loaded.config.provider?.[provider]?.options,
      );
      if (merged) {
        providerOptions[provider] = merged;
      }
    }

    for (const [name, config] of Object.entries(loaded.config.mcp ?? {})) {
      if (config.type === "local") {
        mcpByName.set(name, {
          name,
          type: "local",
          command: config.command,
          ...(config.environment ? { environment: config.environment } : {}),
          ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
          ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
        });
        continue;
      }

      mcpByName.set(name, {
        name,
        type: "remote",
        url: config.url,
        ...(config.headers ? { headers: config.headers } : {}),
        ...(config.enabled !== undefined ? { enabled: config.enabled } : {}),
        ...(config.timeout !== undefined ? { timeout: config.timeout } : {}),
      });
    }

    for (const skillPath of loaded.config.skills?.paths ?? []) {
      const trimmed = trimOrUndefined(skillPath);
      if (!trimmed) {
        continue;
      }
      skillDirectories.add(resolveConfigPath(trimmed, baseDir));
    }

    for (const instructionPattern of loaded.config.instructions ?? []) {
      const trimmed = trimOrUndefined(instructionPattern);
      if (!trimmed) {
        continue;
      }
      instructionPatterns.push({
        baseDir,
        pattern: trimmed,
      });
    }
  }

  return {
    mcpServers: [...mcpByName.values()],
    skillDirectories: [...skillDirectories],
    instructionPatterns,
    providerOptions,
  };
}

export async function loadOpencodeInstructionContents(
  workspaceRoot: string,
): Promise<ReadonlyArray<string>> {
  const interop = await loadOpencodeInterop(workspaceRoot);
  const contents: string[] = [];
  const seenFiles = new Set<string>();

  for (const instruction of interop.instructionPatterns) {
    const absolutePattern = resolveConfigPath(instruction.pattern, instruction.baseDir);
    const matches = await glob(absolutePattern, {
      absolute: true,
      nodir: true,
    }).catch(() => []);

    for (const filePath of matches) {
      if (seenFiles.has(filePath)) {
        continue;
      }
      seenFiles.add(filePath);

      const content = await fs.readFile(filePath, "utf8").catch(() => null);
      if (content && content.trim().length > 0) {
        contents.push(content);
      }
    }
  }

  return contents;
}
