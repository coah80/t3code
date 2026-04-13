import type { HarnessLspServerSettings, HarnessMcpServerSettings } from "@t3tools/contracts";

import { LspManager } from "../../harness/lsp/client.ts";
import type { McpServerConfig } from "../../harness/mcp/client.ts";
import {
  loadOpencodeInterop,
  type OpencodeInteropProvider,
} from "../../harness/opencodeInterop.ts";

export type HarnessUpstreamProvider = "anthropic" | "openai" | "openrouter";
export interface HarnessUpstreamAuth {
  readonly apiKey: string;
  readonly baseURL?: string | undefined;
}

export function parseHarnessModel(model: string): {
  readonly upstream: HarnessUpstreamProvider;
  readonly model: string;
} {
  const trimmed = model.trim();
  if (trimmed.startsWith("anthropic/")) {
    return { upstream: "anthropic", model: trimmed.slice("anthropic/".length) };
  }
  if (trimmed.startsWith("openai/")) {
    return { upstream: "openai", model: trimmed.slice("openai/".length) };
  }
  if (trimmed.startsWith("openrouter/")) {
    return { upstream: "openrouter", model: trimmed.slice("openrouter/".length) };
  }
  if (trimmed.startsWith("claude-")) {
    return { upstream: "anthropic", model: trimmed };
  }
  if (trimmed.startsWith("gpt-")) {
    return { upstream: "openai", model: trimmed };
  }
  return { upstream: "openrouter", model: trimmed };
}

function trimOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readHarnessEnvApiKey(upstream: HarnessUpstreamProvider): string | undefined {
  switch (upstream) {
    case "anthropic":
      return trimOrUndefined(process.env.ANTHROPIC_API_KEY);
    case "openai":
      return trimOrUndefined(process.env.OPENAI_API_KEY);
    case "openrouter":
      return trimOrUndefined(process.env.OPENROUTER_API_KEY);
  }
}

export function toHarnessMcpConfigs(
  servers: ReadonlyArray<HarnessMcpServerSettings>,
): ReadonlyArray<McpServerConfig> {
  const configs: McpServerConfig[] = [];

  for (const server of servers) {
    if (server.type === "local") {
      if (!server.command || server.command.length === 0) {
        continue;
      }
      configs.push({
        name: server.name,
        type: "local",
        command: server.command,
        ...(server.environment ? { environment: server.environment } : {}),
        enabled: server.enabled,
        ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
      });
      continue;
    }

    if (!server.url || server.url.length === 0) {
      continue;
    }

    configs.push({
      name: server.name,
      type: "remote",
      url: server.url,
      ...(server.environment ? { environment: server.environment } : {}),
      enabled: server.enabled,
      ...(server.timeout !== undefined ? { timeout: server.timeout } : {}),
    });
  }

  return configs;
}

async function loadHarnessInterop(workspaceRoot: string) {
  return loadOpencodeInterop(workspaceRoot).catch(() => ({
    mcpServers: [] as ReadonlyArray<McpServerConfig>,
    skillDirectories: [] as ReadonlyArray<string>,
    instructionPatterns: [] as ReadonlyArray<never>,
    providerOptions: {} as Partial<
      Record<OpencodeInteropProvider, { apiKey?: string; baseURL?: string }>
    >,
  }));
}

export async function resolveHarnessUpstreamAuth(options: {
  readonly workspaceRoot: string;
  readonly upstream: HarnessUpstreamProvider;
}): Promise<HarnessUpstreamAuth | undefined> {
  const interop = await loadHarnessInterop(options.workspaceRoot);
  const imported = interop.providerOptions[options.upstream];
  const apiKey = trimOrUndefined(imported?.apiKey) ?? readHarnessEnvApiKey(options.upstream);
  if (!apiKey) {
    return undefined;
  }

  const baseURL = trimOrUndefined(imported?.baseURL);
  return baseURL ? { apiKey, baseURL } : { apiKey };
}

export async function resolveHarnessMcpConfigs(options: {
  readonly workspaceRoot: string;
  readonly servers: ReadonlyArray<HarnessMcpServerSettings>;
}): Promise<ReadonlyArray<McpServerConfig>> {
  const interop = await loadHarnessInterop(options.workspaceRoot);
  const merged = new Map<string, McpServerConfig>();

  for (const config of interop.mcpServers) {
    merged.set(config.name, config);
  }

  for (const config of toHarnessMcpConfigs(options.servers)) {
    merged.set(config.name, config);
  }

  return [...merged.values()];
}

export async function readHarnessProbe(workspaceRoot: string): Promise<{
  readonly status: "ready" | "warning" | "error";
  readonly auth: {
    readonly status: "authenticated" | "unauthenticated";
    readonly type: "apiKey";
    readonly label?: string | undefined;
  };
  readonly message?: string;
}> {
  const interop = await loadHarnessInterop(workspaceRoot);
  const available: string[] = [];
  const importedLabels: string[] = [];

  for (const upstream of ["anthropic", "openai", "openrouter"] as const) {
    const imported = interop.providerOptions[upstream];
    const apiKey = trimOrUndefined(imported?.apiKey) ?? readHarnessEnvApiKey(upstream);
    if (!apiKey) {
      continue;
    }

    const label =
      upstream === "anthropic" ? "Anthropic" : upstream === "openai" ? "OpenAI" : "OpenRouter";
    available.push(label);
    if (trimOrUndefined(imported?.baseURL) || trimOrUndefined(imported?.apiKey)) {
      importedLabels.push(label);
    }
  }

  if (available.length === 0) {
    return {
      status: "error",
      auth: {
        status: "unauthenticated",
        type: "apiKey",
      },
      message:
        "Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY, or provide provider auth in OpenCode config.",
    };
  }

  const importedMessage =
    importedLabels.length > 0 ? ` Imported OpenCode config for ${importedLabels.join(", ")}.` : "";

  return {
    status: "ready",
    auth: {
      status: "authenticated",
      type: "apiKey",
      label: available.join(", "),
    },
    message: `Using provider auth from ${available.join(", ")}.${importedMessage}`,
  };
}

export function createHarnessLspManager(options: {
  readonly enableBuiltinLsp: boolean;
  readonly lspServers: ReadonlyArray<HarnessLspServerSettings>;
}): LspManager | undefined {
  if (!options.enableBuiltinLsp && options.lspServers.length === 0) {
    return undefined;
  }

  const manager = new LspManager({ includeBuiltinServers: options.enableBuiltinLsp });
  for (const server of options.lspServers) {
    if (server.command.length === 0 || server.extensions.length === 0) {
      continue;
    }
    manager.addServer({
      id: server.id,
      command: server.command,
      extensions: server.extensions,
      ...(server.rootMarkers.length > 0 ? { rootMarkers: server.rootMarkers } : {}),
    });
  }

  return manager;
}
