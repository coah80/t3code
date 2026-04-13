import { ChevronDownIcon, CheckIcon, ZapIcon, SparklesIcon, BrainIcon, RocketIcon } from "lucide-react";
import { useState, useRef, useEffect } from "react";

interface ModelOption {
  readonly id: string;
  readonly provider: "anthropic" | "openai" | "openrouter";
  readonly label: string;
  readonly tier: string;
}

const MODEL_OPTIONS: readonly ModelOption[] = [
  { id: "claude-sonnet-4-6", provider: "anthropic", label: "Claude Sonnet 4.6", tier: "standard" },
  { id: "claude-opus-4-6", provider: "anthropic", label: "Claude Opus 4.6", tier: "premium" },
  { id: "claude-haiku-4-5", provider: "anthropic", label: "Claude Haiku 4.5", tier: "fast" },
  { id: "gpt-5.4", provider: "openai", label: "GPT-5.4", tier: "premium" },
  { id: "gpt-5-mini", provider: "openai", label: "GPT-5 Mini", tier: "fast" },
  { id: "o3-mini", provider: "openai", label: "o3-mini", tier: "reasoning" },
  { id: "anthropic/claude-sonnet-4.6", provider: "openrouter", label: "Sonnet 4.6 (OR)", tier: "standard" },
  { id: "openai/gpt-5.4", provider: "openrouter", label: "GPT-5.4 (OR)", tier: "premium" },
  { id: "google/gemini-3.1-pro", provider: "openrouter", label: "Gemini 3.1 Pro", tier: "standard" },
  { id: "google/gemini-3-flash", provider: "openrouter", label: "Gemini 3 Flash", tier: "fast" },
];

const tierIcon = (tier: string) => {
  switch (tier) {
    case "fast": return <ZapIcon className="size-3 text-amber-400" />;
    case "premium": return <SparklesIcon className="size-3 text-purple-400" />;
    case "reasoning": return <BrainIcon className="size-3 text-blue-400" />;
    default: return <RocketIcon className="size-3 text-muted-foreground" />;
  }
};

const providerColor = (provider: string) => {
  switch (provider) {
    case "anthropic": return "text-orange-400";
    case "openai": return "text-emerald-400";
    case "openrouter": return "text-blue-400";
    default: return "text-muted-foreground";
  }
};

interface ModelSwitcherProps {
  readonly currentModel: string;
  readonly isRunning: boolean;
  readonly onSwitch: (modelId: string, provider: "anthropic" | "openai" | "openrouter") => void;
}

export function ModelSwitcher({ currentModel, isRunning, onSwitch }: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const current = MODEL_OPTIONS.find((m) => m.id === currentModel);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs transition-colors hover:bg-accent"
      >
        {current && tierIcon(current.tier)}
        <span className="font-medium">{current?.label ?? currentModel}</span>
        {isRunning && (
          <span className="rounded bg-primary/20 px-1 py-0.5 text-[9px] text-primary animate-pulse">
            running
          </span>
        )}
        <ChevronDownIcon className="size-3 text-muted-foreground" />
      </button>

      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-1 w-64 rounded-lg border border-border bg-popover p-1 shadow-lg">
          <div className="px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
            {isRunning ? "Switch after current turn" : "Select model"}
          </div>

          {["anthropic", "openai", "openrouter"].map((provider) => {
            const models = MODEL_OPTIONS.filter((m) => m.provider === provider);
            if (models.length === 0) return null;

            return (
              <div key={provider}>
                <div className={`px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${providerColor(provider)}`}>
                  {provider === "openrouter" ? "OpenRouter" : provider === "anthropic" ? "Anthropic" : "OpenAI"}
                </div>
                {models.map((model) => (
                  <button
                    key={model.id}
                    type="button"
                    onClick={() => {
                      onSwitch(model.id, model.provider);
                      setOpen(false);
                    }}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                      model.id === currentModel
                        ? "bg-primary/10 text-primary"
                        : "text-foreground hover:bg-accent"
                    }`}
                  >
                    {tierIcon(model.tier)}
                    <span className="flex-1">{model.label}</span>
                    {model.id === currentModel && <CheckIcon className="size-3.5 text-primary" />}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
