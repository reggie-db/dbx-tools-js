import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputButton,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { Action, Actions } from "@/components/ai-elements/actions";
import { Fragment, useState } from "react";
import { Response } from "@/components/ai-elements/response";
import { Shimmer } from "@/components/ai-elements/shimmer";
import {
  CheckIcon,
  CopyIcon,
  GlobeIcon,
  RefreshCcwIcon,
  XIcon,
} from "lucide-react";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@/components/ai-elements/sources";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Spinner } from "@databricks/appkit-ui/react";
import { Suggestion, Suggestions } from "@/components/ai-elements/suggestion";
import type { UIMessage } from "ai";

const DEFAULT_SUGGESTIONS = [
  "Tell me about Spirited Away",
  "Who are the main characters in Princess Mononoke?",
  "Summarize the plot of Howl's Moving Castle",
];

export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

/**
 * Lifecycle of a tool invocation we want to surface in the chat
 * bubble: queued/running while we wait on the tool, done once the
 * `tool-result` chunk lands, or `error` for `tool-error`. Tool name
 * is rendered verbatim apart from `_` -> ` ` and a leading namespace
 * (e.g. `genie_default_`) being dropped for readability.
 *
 * `progress` carries mid-flight {@link ToolProgress} events emitted
 * by the tool itself via Mastra's `ctx.writer` (used by the Genie
 * tool to forward status / SQL / row-count info while it waits on
 * the long-running Databricks call).
 */
export type ToolEvent = {
  id: string;
  toolName: string;
  status: "running" | "done" | "error";
  progress?: ToolProgress[];
};

/**
 * Normalised progress event published by a tool while it runs. The
 * shape mirrors `packages/mastra/src/genie.ts#GenieProgress`; the
 * union is kept open here (`"text"`, `"sql"`, `"data"`, ...) so other
 * tools can publish their own kinds without a UI change.
 */
export type ToolProgress =
  | { kind: "started"; conversationId: string; messageId: string; spaceId: string }
  | { kind: "status"; status: string; label: string }
  | { kind: "sql"; sql: string; title?: string; description?: string; statementId?: string }
  | { kind: "data"; rowCount: number; columns: string[] }
  | { kind: "text"; content: string }
  | { kind: "suggested"; questions: string[] }
  | { kind: "error"; error: string };

export type ChatViewProps = {
  messages: UIMessage[];
  status: ChatStatus;
  sendMessage: (
    message: { text: string; files?: PromptInputMessage["files"] },
    options?: { body?: Record<string, unknown> },
  ) => void;
  regenerate?: () => void;
  suggestions?: string[];
  /**
   * Map of assistant message id -> tool invocations that fired during
   * that turn. Rendered as inline status pills inside the bubble so
   * long-running tools (e.g. Genie SQL) give visible feedback while
   * the LLM is waiting on a `tool-result` chunk.
   */
  toolEventsByMessage?: Record<string, ToolEvent[]>;
};

const humanizeToolName = (toolName: string): string =>
  toolName
    .replace(/^[a-z0-9]+_(?:default|primary)_/i, "")
    .replace(/[._]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();

/**
 * Pick the freshest user-facing label for a running tool. When the
 * tool has published status updates (Genie does this with each step
 * of FETCHING_METADATA / ASKING_AI / EXECUTING_QUERY), use the latest
 * one so the shimmer text actually tracks what the backend is doing
 * instead of stalling on a generic "calling X".
 */
const runningLabelFor = (event: ToolEvent): string => {
  const latestStatus = [...(event.progress ?? [])]
    .reverse()
    .find((p): p is Extract<ToolProgress, { kind: "status" }> => p.kind === "status");
  if (latestStatus) return latestStatus.label;
  return `calling ${humanizeToolName(event.toolName)}`;
};

const ToolProgressDetails = ({ progress }: { progress: ToolProgress[] }) => {
  // We filter out "status" / "started" because those drive the pill
  // label itself; only the substantive payloads (SQL, row counts,
  // suggestions, errors) make it into the detail list.
  const detailed = progress.filter(
    (p) => p.kind !== "status" && p.kind !== "started",
  );
  if (detailed.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {detailed.map((p, i) => {
        switch (p.kind) {
          case "sql":
            return (
              <details
                key={`sql-${i}`}
                className="rounded border border-border/60 bg-background/40 text-xs"
              >
                <summary className="cursor-pointer px-2 py-1 text-muted-foreground">
                  SQL{p.title ? `: ${p.title}` : ""}
                </summary>
                <pre className="overflow-x-auto px-2 pb-2 text-foreground">
                  <code>{p.sql}</code>
                </pre>
                {p.description && (
                  <p className="px-2 pb-2 text-muted-foreground">{p.description}</p>
                )}
              </details>
            );
          case "data":
            return (
              <div
                key={`data-${i}`}
                className="text-xs text-muted-foreground"
              >
                returned {p.rowCount} row{p.rowCount === 1 ? "" : "s"}
                {p.columns.length > 0
                  ? ` · ${p.columns.slice(0, 6).join(", ")}${p.columns.length > 6 ? "..." : ""}`
                  : ""}
              </div>
            );
          case "suggested":
            return (
              <div key={`sugg-${i}`} className="flex flex-wrap gap-1">
                {p.questions.map((q, j) => (
                  <span
                    key={j}
                    className="rounded-full border border-border/60 px-2 py-0.5 text-xs text-muted-foreground"
                  >
                    {q}
                  </span>
                ))}
              </div>
            );
          case "text":
            return (
              <p
                key={`text-${i}`}
                className="text-xs text-muted-foreground italic"
              >
                {p.content}
              </p>
            );
          case "error":
            return (
              <p
                key={`err-${i}`}
                className="text-xs text-destructive"
              >
                {p.error}
              </p>
            );
          default:
            return null;
        }
      })}
    </div>
  );
};

const ToolStatusList = ({ events }: { events: ToolEvent[] }) => (
  <div className="mb-2 flex flex-col gap-2">
    {events.map((event) => {
      const isRunning = event.status === "running";
      const isError = event.status === "error";
      const Icon = isError ? XIcon : CheckIcon;
      return (
        <div
          key={event.id}
          className="flex flex-col gap-1 rounded-md border border-border/40 bg-background/30 px-2 py-1.5"
        >
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {isRunning ? (
              <>
                <Spinner className="size-3" />
                <Shimmer as="span" duration={1.5}>
                  {runningLabelFor(event)}
                </Shimmer>
              </>
            ) : (
              <>
                <Icon className={isError ? "size-3 text-destructive" : "size-3"} />
                <span>
                  {isError ? "failed " : "called "}
                  {humanizeToolName(event.toolName)}
                </span>
              </>
            )}
          </div>
          {event.progress && event.progress.length > 0 && (
            <ToolProgressDetails progress={event.progress} />
          )}
        </div>
      );
    })}
  </div>
);

type MessagePartWithReasoningText = {
  type: string;
  text?: string;
};

const getVisibleReasoningText = (parts: MessagePartWithReasoningText[]) =>
  parts
    .filter((part) => part.type === "reasoning")
    .map((part) => part.text ?? "")
    .join("\n\n");

export const ChatView = ({
  messages,
  status,
  sendMessage,
  regenerate,
  suggestions = DEFAULT_SUGGESTIONS,
  toolEventsByMessage = {},
}: ChatViewProps) => {
  const [input, setInput] = useState("");
  const [webSearch, setWebSearch] = useState(false);

  // Show the loader whenever the request is in flight but the assistant
  // hasn't produced any visible signal yet. Without this the indicator
  // disappears as soon as the status flips to "streaming", which can
  // happen before the first text-delta / reasoning-delta lands and
  // leaves an empty gap on screen. Tool indicators are rendered
  // inline in the bubble, so once any tool event exists for the
  // current assistant id we hand the wait UI off to that and hide
  // the standalone spinner.
  const lastMessage = messages.at(-1);
  const lastToolEvents = lastMessage ? toolEventsByMessage[lastMessage.id] : undefined;
  const lastIsAssistantWithContent =
    lastMessage?.role === "assistant" &&
    (lastMessage.parts.some(
      (part) =>
        (part.type === "text" || part.type === "reasoning") &&
        Boolean((part as { text?: string }).text),
    ) ||
      (lastToolEvents?.length ?? 0) > 0);
  const isWaiting =
    (status === "submitted" || status === "streaming") && !lastIsAssistantWithContent;

  const handleSubmit = (message: PromptInputMessage) => {
    const hasText = Boolean(message.text);
    const hasAttachments = Boolean(message.files?.length);
    if (!(hasText || hasAttachments)) return;

    sendMessage(
      {
        text: message.text || "Sent with attachments",
        files: message.files,
      },
      { body: { webSearch } },
    );
    setInput("");
  };

  const handleSuggestionClick = (suggestion: string) => {
    sendMessage({ text: suggestion });
  };

  return (
    <div className="max-w-4xl mx-auto p-0 md:p-6 relative size-full">
      <div className="flex flex-col h-full">
        <Conversation className="h-full">
          <ConversationContent>
            {messages.map((message, messageIndex) => {
              const isLastAssistantMessage =
                message.role === "assistant" && messageIndex === messages.length - 1;
              const reasoningText = getVisibleReasoningText(message.parts);
              const isReasoningStreaming =
                isLastAssistantMessage &&
                status === "streaming" &&
                message.parts.at(-1)?.type === "reasoning";
              const events =
                message.role === "assistant" ? toolEventsByMessage[message.id] : undefined;
              const hasTextPart = message.parts.some((p) => p.type === "text");

              return (
                <div key={message.id}>
                  {message.role === "assistant" &&
                    message.parts.filter((part) => part.type === "source-url").length >
                      0 && (
                      <Sources>
                        <SourcesTrigger
                          count={
                            message.parts.filter((part) => part.type === "source-url")
                              .length
                          }
                        />
                        {message.parts
                          .filter((part) => part.type === "source-url")
                          .map((part, i) => (
                            <SourcesContent key={`${message.id}-${i}`}>
                              <Source
                                key={`${message.id}-${i}`}
                                href={part.url}
                                title={part.url}
                              />
                            </SourcesContent>
                          ))}
                      </Sources>
                    )}
                  {reasoningText && (
                    <Reasoning className="w-full" isStreaming={isReasoningStreaming}>
                      <ReasoningTrigger />
                      <ReasoningContent>{reasoningText}</ReasoningContent>
                    </Reasoning>
                  )}
                  {events && events.length > 0 && !hasTextPart && (
                    <Message from={message.role}>
                      <MessageContent>
                        <ToolStatusList events={events} />
                      </MessageContent>
                    </Message>
                  )}
                  {message.parts.map((part, i) => {
                    const firstTextIdx = message.parts.findIndex(
                      (p) => p.type === "text",
                    );
                    switch (part.type) {
                      case "text":
                        return (
                          <Fragment key={`${message.id}-${i}`}>
                            <Message from={message.role}>
                              <MessageContent>
                                {i === firstTextIdx &&
                                  events &&
                                  events.length > 0 && (
                                    <ToolStatusList events={events} />
                                  )}
                                <Response>{part.text}</Response>
                              </MessageContent>
                            </Message>
                            {isLastAssistantMessage && (
                              <Actions className="mt-2">
                                {regenerate && (
                                  <Action onClick={() => regenerate()} label="Retry">
                                    <RefreshCcwIcon className="size-3" />
                                  </Action>
                                )}
                                <Action
                                  onClick={() =>
                                    navigator.clipboard.writeText(part.text)
                                  }
                                  label="Copy"
                                >
                                  <CopyIcon className="size-3" />
                                </Action>
                              </Actions>
                            )}
                          </Fragment>
                        );
                      case "reasoning":
                        return null;
                      default:
                        return null;
                    }
                  })}
                </div>
              );
            })}
            {isWaiting && <Spinner className="size-5 text-muted-foreground" />}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <Suggestions>
          {suggestions.map((suggestion) => (
            <Suggestion
              key={suggestion}
              onClick={handleSuggestionClick}
              suggestion={suggestion}
            />
          ))}
        </Suggestions>

        <PromptInput onSubmit={handleSubmit} className="mt-4" globalDrop multiple>
          <PromptInputBody>
            <PromptInputAttachments>
              {(attachment) => <PromptInputAttachment data={attachment} />}
            </PromptInputAttachments>
            <PromptInputTextarea
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                setInput(e.target.value)
              }
              value={input}
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger />
                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments />
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
              <PromptInputButton
                variant={webSearch ? "default" : "ghost"}
                onClick={() => setWebSearch(!webSearch)}
              >
                <GlobeIcon size={16} />
                <span>Search</span>
              </PromptInputButton>
            </PromptInputTools>
            <PromptInputSubmit disabled={!input && !status} status={status} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
};
