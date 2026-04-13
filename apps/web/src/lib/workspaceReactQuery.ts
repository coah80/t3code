import { queryOptions, mutationOptions, type QueryClient } from "@tanstack/react-query";
import { ensureLocalApi } from "../localApi";

export const workspaceQueryKeys = {
  all: ["workspace"] as const,
  discover: () => ["workspace", "discover"] as const,
};

export function workspaceDiscoverQueryOptions() {
  return queryOptions({
    queryKey: workspaceQueryKeys.discover(),
    queryFn: async () => {
      const api = ensureLocalApi();
      return api.workspace.discover();
    },
    staleTime: 30000,
  });
}

export function workspaceCreateMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: async (name: string) => {
      const api = ensureLocalApi();
      return api.workspace.create(name);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: workspaceQueryKeys.all });
    },
  });
}

export function workspaceSwitchMutationOptions() {
  return mutationOptions({
    mutationFn: async (_path: string) => {
      // Workspace switching is handled by the environment system
      // This is a no-op stub — actual switching happens via project add/remove
      return { ok: true, path: _path };
    },
  });
}
