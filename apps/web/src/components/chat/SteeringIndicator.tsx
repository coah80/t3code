import { NavigationIcon, ListOrderedIcon } from "lucide-react";

interface SteeringIndicatorProps {
  readonly behavior: "steer" | "queue";
  readonly queueCount: number;
  readonly isRunning: boolean;
  readonly onToggleBehavior: () => void;
}

export function SteeringIndicator({
  behavior,
  queueCount,
  isRunning,
  onToggleBehavior,
}: SteeringIndicatorProps) {
  if (!isRunning && queueCount === 0) return null;

  return (
    <div className="flex items-center gap-2">
      {isRunning && (
        <button
          type="button"
          onClick={onToggleBehavior}
          className={`flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium transition-colors ${
            behavior === "steer" ? "bg-primary/15 text-primary" : "bg-amber-500/15 text-amber-500"
          }`}
          title={`Send key: ${behavior === "steer" ? "Steer (guide active run)" : "Queue (send after)"}`}
        >
          {behavior === "steer" ? (
            <>
              <NavigationIcon className="size-2.5" />
              Steer
            </>
          ) : (
            <>
              <ListOrderedIcon className="size-2.5" />
              Queue
            </>
          )}
        </button>
      )}

      {queueCount > 0 && (
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {queueCount} queued
        </span>
      )}
    </div>
  );
}
