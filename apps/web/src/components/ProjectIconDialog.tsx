import type { ProjectIcon } from "@t3tools/contracts";
import { ImagePlusIcon, RotateCcwIcon } from "lucide-react";
import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { PROJECT_ICON_PRESETS, ProjectIconOverride } from "~/projectIcons";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

const MAX_CUSTOM_PROJECT_ICON_FILE_BYTES = 384 * 1024;

function iconsEqual(left: ProjectIcon | null, right: ProjectIcon | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const handleError = () =>
      reject(reader.error ?? new Error("Could not read the selected file."));
    const handleLoad = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Unexpected file reader result."));
        return;
      }
      resolve(reader.result);
    };
    reader.addEventListener("error", handleError, { once: true });
    reader.addEventListener("load", handleLoad, { once: true });
    reader.readAsDataURL(file);
  });
}

export function ProjectIconDialog({
  open,
  projectName,
  initialIcon,
  onOpenChange,
  onSave,
}: {
  readonly open: boolean;
  readonly projectName: string;
  readonly initialIcon: ProjectIcon | null | undefined;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSave: (icon: ProjectIcon | null) => Promise<void> | void;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [draftIcon, setDraftIcon] = useState<ProjectIcon | null>(initialIcon ?? null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }
    setDraftIcon(initialIcon ?? null);
    setUploadError(null);
    setIsSaving(false);
  }, [initialIcon, open]);

  const hasChanges = useMemo(
    () => !iconsEqual(draftIcon ?? null, initialIcon ?? null),
    [draftIcon, initialIcon],
  );

  const handleCustomFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }

    const isExplicitImage =
      file.type.startsWith("image/") ||
      file.name.toLowerCase().endsWith(".svg") ||
      file.name.toLowerCase().endsWith(".ico");
    if (!isExplicitImage) {
      setUploadError("Choose an image or icon file.");
      return;
    }
    if (file.size > MAX_CUSTOM_PROJECT_ICON_FILE_BYTES) {
      setUploadError("Choose an image smaller than 384 KB.");
      return;
    }

    try {
      const dataUrl = await readFileAsDataUrl(file);
      if (!dataUrl.startsWith("data:image/")) {
        setUploadError("The selected file could not be loaded as an image.");
        return;
      }
      setDraftIcon({ kind: "custom", dataUrl });
      setUploadError(null);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Could not read the selected file.");
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave(draftIcon ?? null);
      onOpenChange(false);
      setUploadError(null);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Could not update the project icon.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Choose folder icon</DialogTitle>
          <DialogDescription>
            Set a custom icon for <span className="font-medium text-foreground">{projectName}</span>
            . Preset icons use Material Symbols, and custom uploads are stored with the project
            metadata.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="space-y-5">
          <div className="flex items-center gap-4 rounded-2xl border border-border/70 bg-muted/25 px-4 py-4">
            <div className="flex size-14 items-center justify-center rounded-2xl border border-border/70 bg-background shadow-sm">
              <ProjectIconOverride icon={draftIcon} className="size-7 text-[28px]" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="font-medium text-sm text-foreground">
                {draftIcon?.kind === "custom"
                  ? "Custom uploaded icon"
                  : draftIcon?.kind === "preset"
                    ? "Preset icon"
                    : "Automatic project favicon"}
              </p>
              <p className="text-sm text-muted-foreground">
                {draftIcon
                  ? "This override replaces the auto-detected favicon for the project row."
                  : "No override is set. The sidebar will keep using the project favicon or a folder icon fallback."}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <div>
              <p className="font-medium text-sm text-foreground">Preset icons</p>
              <p className="text-sm text-muted-foreground">
                Pick a built-in symbol for the project folder.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {PROJECT_ICON_PRESETS.map((preset) => {
                const selected = draftIcon?.kind === "preset" && draftIcon.preset === preset.preset;
                return (
                  <button
                    key={preset.preset}
                    type="button"
                    className={cn(
                      "flex items-center gap-3 rounded-xl border px-3 py-2 text-left transition-colors",
                      selected
                        ? "border-primary/55 bg-primary/8 text-foreground shadow-sm"
                        : "border-border/70 bg-background hover:border-primary/25 hover:bg-muted/30",
                    )}
                    onClick={() => {
                      setDraftIcon({ kind: "preset", preset: preset.preset });
                      setUploadError(null);
                    }}
                  >
                    <ProjectIconOverride
                      icon={{ kind: "preset", preset: preset.preset }}
                      className="size-5 text-[20px]"
                    />
                    <span className="truncate text-sm">{preset.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div>
              <p className="font-medium text-sm text-foreground">Custom image</p>
              <p className="text-sm text-muted-foreground">
                Upload a small square-ish image, SVG, or icon file.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" onClick={() => fileInputRef.current?.click()}>
                <ImagePlusIcon className="size-4" />
                Upload image
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={!draftIcon}
                onClick={() => {
                  setDraftIcon(null);
                  setUploadError(null);
                }}
              >
                <RotateCcwIcon className="size-4" />
                Reset to automatic
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,.svg,.ico"
                className="hidden"
                onChange={(event) => {
                  void handleCustomFileChange(event);
                }}
              />
            </div>

            {uploadError ? <p className="text-destructive text-sm">{uploadError}</p> : null}
          </div>
        </DialogPanel>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!hasChanges || isSaving}
            onClick={() => void handleSave()}
          >
            Save icon
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
