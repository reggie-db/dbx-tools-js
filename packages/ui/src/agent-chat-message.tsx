import { Avatar, AvatarFallback, Card, cn } from "@databricks/appkit-ui/react";
import { Loader2 } from "lucide-react";
import { Markdown } from "./markdown.js";
import { ToolCallCard } from "./tool-call-card.js";
import type { ChatTurn, ToolCall } from "./types.js";

// Single chat bubble. Mirrors @databricks/appkit-ui's GenieChatMessage layout
// (Avatar + Card column, markdown body, user vs assistant theming) and adds
// inline tool-call cards above the assistant text.

// Defense-in-depth filter for phantom tool calls. The Databricks adapter's
// `DbxToolsAdapter` is supposed to suppress these at the source, but if any
// slip through (e.g. an older adapter, a different model, a future regression)
// they show up as `text_call_*` ids resolving to `Unknown tool: <fn>` output.
// Hide them so the SQL the assistant wrote in its final answer doesn't
// double as a long list of empty failed tool calls.
function _isPhantomToolCall(tc: ToolCall): boolean {
  if (tc.callId.startsWith("text_call_")) return true;
  if (tc.status === "done" && typeof tc.output === "string") {
    return /^Unknown tool:/i.test(tc.output.trim());
  }
  return false;
}

export interface AgentChatMessageProps {
  turn: ChatTurn;
  className?: string;
}

export function AgentChatMessage({ turn, className }: AgentChatMessageProps) {
  const isUser = turn.role === "user";
  const visibleToolCalls = turn.toolCalls.filter((tc) => !_isPhantomToolCall(tc));

  return (
    <div
      className={cn(
        "flex gap-3",
        isUser ? "flex-row-reverse" : "flex-row",
        className,
      )}
    >
      <Avatar className="h-8 w-8 shrink-0 mt-1">
        <AvatarFallback
          className={cn(
            "text-xs font-medium",
            isUser ? "bg-primary text-primary-foreground" : "bg-muted",
          )}
        >
          {isUser ? "You" : "AI"}
        </AvatarFallback>
      </Avatar>

      <div className="flex flex-col gap-2 max-w-[80%] min-w-0 overflow-hidden">
        {visibleToolCalls.length > 0 && (
          <div className="flex flex-col gap-1.5 w-full">
            {visibleToolCalls.map((tc) => (
              <ToolCallCard key={tc.callId} call={tc} />
            ))}
          </div>
        )}

        {(turn.content ||
          turn.status === "error" ||
          (turn.status === "streaming" && visibleToolCalls.length === 0)) && (
          <Card
            className={cn(
              "w-full px-4 py-3 overflow-hidden",
              isUser
                ? "bg-primary text-primary-foreground [&_*::selection]:bg-primary-foreground/30 [&::selection]:bg-primary-foreground/30"
                : "bg-muted",
            )}
          >
            {isUser ? (
              <div className="whitespace-pre-wrap text-sm leading-relaxed">
                {turn.content}
              </div>
            ) : turn.content ? (
              <Markdown>{turn.content}</Markdown>
            ) : turn.status === "streaming" ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking...
              </div>
            ) : null}

            {turn.status === "error" && (
              <p className="text-sm text-destructive mt-1">
                {turn.errorText ?? "Stream failed"}
              </p>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
