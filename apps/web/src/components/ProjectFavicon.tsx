import type { EnvironmentId, ProjectIcon } from "@t3tools/contracts";
import { FolderIcon } from "lucide-react";
import { useState } from "react";
import { resolveEnvironmentHttpUrl } from "../environments/runtime";
import { ProjectIconOverride } from "../projectIcons";

const loadedProjectFaviconSrcs = new Set<string>();

export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  projectIcon?: ProjectIcon | null | undefined;
  className?: string | undefined;
}) {
  if (input.projectIcon) {
    return <ProjectIconOverride icon={input.projectIcon} className={input.className} />;
  }

  const src = resolveEnvironmentHttpUrl({
    environmentId: input.environmentId,
    pathname: "/api/project-favicon",
    searchParams: { cwd: input.cwd },
  });
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    loadedProjectFaviconSrcs.has(src) ? "loaded" : "loading",
  );

  return (
    <>
      {status !== "loaded" ? (
        <FolderIcon
          className={`size-3.5 shrink-0 text-muted-foreground/50 ${input.className ?? ""}`}
        />
      ) : null}
      <img
        src={src}
        alt=""
        className={`size-3.5 shrink-0 rounded-sm object-contain ${status === "loaded" ? "" : "hidden"} ${input.className ?? ""}`}
        onLoad={() => {
          loadedProjectFaviconSrcs.add(src);
          setStatus("loaded");
        }}
        onError={() => setStatus("error")}
      />
    </>
  );
}
