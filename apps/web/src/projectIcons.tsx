import type { ProjectIcon, ProjectIconPreset } from "@t3tools/contracts";
import { FolderIcon } from "lucide-react";

import { cn } from "./lib/utils";

export const PROJECT_ICON_PRESETS: ReadonlyArray<{
  readonly preset: ProjectIconPreset;
  readonly label: string;
  readonly symbol: string;
}> = [
  { preset: "folder", label: "Folder", symbol: "folder" },
  { preset: "code", label: "Code", symbol: "code_blocks" },
  { preset: "terminal", label: "Terminal", symbol: "terminal" },
  { preset: "robot", label: "Robot", symbol: "smart_toy" },
  { preset: "rocket", label: "Rocket", symbol: "rocket_launch" },
  { preset: "database", label: "Database", symbol: "database" },
  { preset: "globe", label: "Globe", symbol: "public" },
  { preset: "palette", label: "Palette", symbol: "palette" },
  { preset: "games", label: "Games", symbol: "sports_esports" },
  { preset: "sparkles", label: "Sparkles", symbol: "auto_awesome" },
  { preset: "brain", label: "Brain", symbol: "psychology" },
  { preset: "workflow", label: "Workflow", symbol: "hub" },
];

function lookupProjectIconPreset(preset: ProjectIconPreset) {
  return PROJECT_ICON_PRESETS.find((entry) => entry.preset === preset) ?? PROJECT_ICON_PRESETS[0]!;
}

export function ProjectIconOverride({
  icon,
  className,
}: {
  readonly icon: ProjectIcon | null | undefined;
  readonly className?: string | undefined;
}) {
  if (!icon) {
    return <FolderIcon className={cn("size-4 shrink-0 text-muted-foreground/50", className)} />;
  }

  if (icon.kind === "custom") {
    return (
      <img
        src={icon.dataUrl}
        alt=""
        className={cn("size-4 shrink-0 rounded-sm object-cover", className)}
      />
    );
  }

  const preset = lookupProjectIconPreset(icon.preset);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "material-symbols-rounded inline-flex shrink-0 items-center justify-center text-[16px] leading-none text-muted-foreground/70",
        className,
      )}
    >
      {preset.symbol}
    </span>
  );
}

export function projectIconPresetLabel(preset: ProjectIconPreset): string {
  return lookupProjectIconPreset(preset).label;
}
