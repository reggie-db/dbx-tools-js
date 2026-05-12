import { cn } from "@databricks/appkit-ui/react";
import { ChevronDown, ChevronRight, Loader2, Wrench } from "lucide-react";
import { useState } from "react";
import type { ToolCall } from "./types.js";

// Collapsible tool-call card shown inline above the assistant text bubble.
// While running, the last few phase labels stream in underneath the header
// (driven by the tool-progress SSE bus); when expanded, the user can inspect
// the raw args, phase log, and tool output.

function parseArgs(json: string | undefined): Record<string, unknown> | string {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return json;
  }
}

function summarizeArgs(args: Record<string, unknown> | string): string {
  if (typeof args === "string") return args.slice(0, 80);
  const path = args.path;
  if (typeof path === "string" && path.length > 0) return path;
  const content = args.content;
  if (typeof content === "string" && content.length > 0) {
    const trimmed = content.slice(0, 60);
    return content.length > 60 ? `${trimmed}...` : trimmed;
  }
  const keys = Object.keys(args);
  if (keys.length === 0) return "(no args)";
  return keys
    .map((k) => `${k}=${JSON.stringify(args[k]).slice(0, 30)}`)
    .join(", ");
}

function summarizeOutput(output: string | undefined): {
  preview: string;
  truncated: boolean;
} {
  if (!output) return { preview: "", truncated: false };
  const firstLine = output.split(/\r?\n/, 1)[0] ?? "";
  const preview =
    firstLine.length > 120 ? `${firstLine.slice(0, 120)}...` : firstLine;
  return { preview, truncated: output.length > preview.length };
}

export interface ToolCallCardProps {
  call: ToolCall;
  className?: string;
}

export function ToolCallCard({ call, className }: ToolCallCardProps) {
  const [open, setOpen] = useState(false);
  const args = parseArgs(call.args);
  const { preview, truncated } = summarizeOutput(call.output);

  const Icon = call.status === "running" ? Loader2 : Wrench;
  const iconClass = call.status === "running" ? "animate-spin" : "";

  return (
    <div className={cn("rounded-md border bg-muted/40 text-xs", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-muted"
      >
        {open ? (
          <ChevronDown className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" />
        )}
        <Icon
          className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground", iconClass)}
        />
        <span className="font-mono text-[11px]">{call.name}</span>
        <span className="text-muted-foreground truncate">
          ({summarizeArgs(args)})
        </span>
        {call.status === "done" && preview && (
          <span className="ml-auto text-muted-foreground truncate max-w-[40%]">
            → {preview}
          </span>
        )}
        {call.status === "error" && (
          <span className="ml-auto text-destructive">error</span>
        )}
      </button>
      {call.status === "running" && call.statusUpdates.length > 0 && (
        <div className="border-t px-2.5 py-1.5 space-y-0.5 text-[11px] text-muted-foreground">
          {call.statusUpdates.slice(-3).map((u, idx, arr) => (
            <div
              key={`${u.ts}-${idx}`}
              className="flex items-center gap-1.5"
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full shrink-0",
                  u.phase === "error"
                    ? "bg-destructive"
                    : idx === arr.length - 1
                      ? "bg-primary animate-pulse"
                      : "bg-muted-foreground/40",
                )}
              />
              <span className="truncate">{u.label}</span>
            </div>
          ))}
        </div>
      )}
      {open && (
        <div className="border-t px-2.5 py-1.5 space-y-1.5 font-mono text-[11px]">
          <div>
            <div className="text-muted-foreground">args</div>
            <pre className="whitespace-pre-wrap break-all">
              {typeof args === "string" ? args : JSON.stringify(args, null, 2)}
            </pre>
          </div>
          {call.statusUpdates.length > 0 && (
            <div>
              <div className="text-muted-foreground">phases</div>
              <ul className="space-y-0.5">
                {call.statusUpdates.map((u, idx) => (
                  <li key={`${u.ts}-${idx}`}>
                    {new Date(u.ts).toLocaleTimeString()} {u.phase}: {u.label}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(call.output || truncated) && (
            <div>
              <div className="text-muted-foreground">result</div>
              <pre className="whitespace-pre-wrap break-all max-h-64 overflow-auto">
                {call.output ?? ""}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
