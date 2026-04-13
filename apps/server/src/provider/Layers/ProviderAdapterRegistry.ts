/**
 * ProviderAdapterRegistryLive - In-memory provider adapter lookup layer.
 *
 * Binds provider kinds (codex/claudeAgent/...) to concrete adapter services.
 * This layer only performs adapter lookup; it does not route session-scoped
 * calls or own provider lifecycle workflows.
 *
 * @module ProviderAdapterRegistryLive
 */
import { Effect, Layer } from "effect";

import { ServerSettingsService } from "../../serverSettings";
import { ProviderUnsupportedError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "../Services/ProviderAdapterRegistry.ts";
import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";
import { HarnessAdapter } from "../Services/HarnessAdapter.ts";
import { makeRoutedProviderAdapter } from "./routedProviderAdapter";

export interface ProviderAdapterRegistryLiveOptions {
  readonly adapters?: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>;
}

const makeProviderAdapterRegistry = Effect.fn("makeProviderAdapterRegistry")(function* (
  options?: ProviderAdapterRegistryLiveOptions,
) {
  let activeAdapters: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>;
  if (options?.adapters !== undefined) {
    activeAdapters = options.adapters;
  } else {
    const nativeCodexAdapter = yield* CodexAdapter;
    const nativeClaudeAdapter = yield* ClaudeAdapter;
    const harnessAdapter = yield* HarnessAdapter;
    const serverSettings = yield* ServerSettingsService;

    activeAdapters = [
      makeRoutedProviderAdapter({
        provider: "codex",
        nativeAdapter: nativeCodexAdapter,
        harnessAdapter,
        serverSettings,
      }),
      makeRoutedProviderAdapter({
        provider: "claudeAgent",
        nativeAdapter: nativeClaudeAdapter,
        harnessAdapter,
        serverSettings,
      }),
      harnessAdapter,
    ] satisfies ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>;
  }
  const byProvider = new Map(activeAdapters.map((adapter) => [adapter.provider, adapter]));

  const getByProvider: ProviderAdapterRegistryShape["getByProvider"] = (provider) => {
    const adapter = byProvider.get(provider);
    if (!adapter) {
      return Effect.fail(new ProviderUnsupportedError({ provider }));
    }
    return Effect.succeed(adapter);
  };

  const listProviders: ProviderAdapterRegistryShape["listProviders"] = () =>
    Effect.sync(() => Array.from(byProvider.keys()));

  return {
    getByProvider,
    listProviders,
  } satisfies ProviderAdapterRegistryShape;
});

export const ProviderAdapterRegistryLive = Layer.effect(
  ProviderAdapterRegistry,
  makeProviderAdapterRegistry(),
);
