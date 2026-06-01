import { useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowDownIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  MessageSquareIcon,
  RefreshCcwIcon,
  SendIcon,
  SparklesIcon,
  UserIcon,
  XIcon,
} from "lucide-react";
import {
  Avatar,
  AvatarFallback,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
  Item,
  ItemContent,
  ItemMedia,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Spinner,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  cn,
} from "@databricks/appkit-ui/react";

const DEFAULT_SUGGESTIONS = [
  "Tell me about Spirited Away",
  "Who are the main characters in Princess Mononoke?",
  "Summarize the plot of Howl's Moving Castle",
];

const BOTTOM_THRESHOLD_PX = 24;

export type ChatStatus = "submitted" | "streaming" | "ready" | "error";

/**
 * Lifecycle of a single tool invocation surfaced inline in the assistant
 * bubble. `running` while we wait for the backend, `done` on `tool-result`,
 * `error` on `tool-error`. `progress` is an in-order log of mid-flight
 * events the tool itself pushed through Mastra's `ctx.writer`.
 */
export type ToolEvent = {
  id: string;
  toolName: string;
  status: "running" | "done" | "error";
  progress?: ToolProgress[];
};

/**
 * Normalised progress event shape; mirrors `GenieProgress` in the Mastra
 * Genie tool wrapper. Open union so new tools can publish new kinds
 * without breaking existing renders.
 */
export type ToolProgress =
  | { kind: "started"; conversationId: string; messageId: string; spaceId: string }
  | { kind: "status"; status: string; label: string }
  | { kind: "sql"; sql: string; title?: string; description?: string; statementId?: string }
  | { kind: "data"; rowCount: number; columns: string[] }
  | { kind: "text"; content: string }
  | { kind: "suggested"; questions: string[] }
  | { kind: "error"; error: string };

/** Subset of a Model Serving endpoint surfaced in the model picker. */
export type ChatModelOption = { name: string };

export type ChatViewProps = {
  messages: UIMessage[];
  status: ChatStatus;
  sendMessage: (message: { text: string }) => void;
  regenerate?: () => void;
  suggestions?: string[];
  toolEventsByMessage?: Record<string, ToolEvent[]>;
  /** Available model endpoints. Pass an empty array (or omit) to hide the picker. */
  models?: ChatModelOption[];
  /** Currently selected model name; empty string means "use server default". */
  model?: string;
  onModelChange?: (model: string) => void;
};

/**
 * Strip noisy provider prefixes (e.g. `genie_default_`) and turn
 * snake/camel into a flat lower-case label the user can read.
 */
const humanizeToolName = (toolName: string): string =>
  toolName
    .replace(/^[a-z0-9]+_(?:default|primary)_/i, "")
    .replace(/[._]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();

/**
 * Track the freshest status label a running tool has published so the
 * inline pill follows the backend (FETCHING_METADATA -> EXECUTING_QUERY)
 * instead of stalling on a generic "calling X".
 */
const runningLabelFor = (event: ToolEvent): string => {
  const latest = [...(event.progress ?? [])]
    .reverse()
    .find((p): p is Extract<ToolProgress, { kind: "status" }> => p.kind === "status");
  return latest ? latest.label : `calling ${humanizeToolName(event.toolName)}`;
};

const getReasoningText = (parts: UIMessage["parts"]): string =>
  parts
    .filter((p): p is { type: "reasoning"; text: string } => p.type === "reasoning")
    .map((p) => p.text)
    .join("\n\n");

const ToolProgressDetails = ({ progress }: { progress: ToolProgress[] }) => {
  const detailed = progress.filter((p) => p.kind !== "status" && p.kind !== "started");
  if (detailed.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {detailed.map((p, i) => {
        switch (p.kind) {
          case "sql":
            return (
              <Collapsible key={`sql-${i}`} className="rounded border border-border/60 bg-background/40 text-xs">
                <CollapsibleTrigger className="flex w-full items-center gap-1 px-2 py-1 text-left text-muted-foreground hover:text-foreground">
                  <ChevronDownIcon className="size-3" />
                  <span>SQL{p.title ? `: ${p.title}` : ""}</span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <pre className="overflow-x-auto px-2 pb-2 text-foreground">
                    <code>{p.sql}</code>
                  </pre>
                  {p.description && (
                    <p className="px-2 pb-2 text-muted-foreground">{p.description}</p>
                  )}
                </CollapsibleContent>
              </Collapsible>
            );
          case "data":
            return (
              <div key={`data-${i}`} className="text-xs text-muted-foreground">
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
              <p key={`text-${i}`} className="text-xs italic text-muted-foreground">
                {p.content}
              </p>
            );
          case "error":
            return (
              <p key={`err-${i}`} className="text-xs text-destructive">
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

const ToolEventPill = ({ event }: { event: ToolEvent }) => {
  const isRunning = event.status === "running";
  const isError = event.status === "error";
  return (
    <div className="flex flex-col gap-1 rounded-md border border-border/40 bg-background/30 px-2 py-1.5">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {isRunning ? (
          <>
            <Spinner className="size-3" />
            <span className="animate-pulse">{runningLabelFor(event)}</span>
          </>
        ) : isError ? (
          <>
            <XIcon className="size-3 text-destructive" />
            <span>failed {humanizeToolName(event.toolName)}</span>
          </>
        ) : (
          <>
            <CheckIcon className="size-3" />
            <span>called {humanizeToolName(event.toolName)}</span>
          </>
        )}
      </div>
      {event.progress && event.progress.length > 0 && (
        <ToolProgressDetails progress={event.progress} />
      )}
    </div>
  );
};

const ToolEventList = ({ events }: { events: ToolEvent[] }) => (
  <div className="mb-2 flex flex-col gap-2">
    {events.map((event) => (
      <ToolEventPill key={event.id} event={event} />
    ))}
  </div>
);

const RoleAvatar = ({ role }: { role: UIMessage["role"] }) => (
  <Avatar className="size-7">
    <AvatarFallback>
      {role === "assistant" ? (
        <SparklesIcon className="size-4" />
      ) : (
        <UserIcon className="size-4" />
      )}
    </AvatarFallback>
  </Avatar>
);

/**
 * GitHub-flavoured Markdown renderer. `remark-gfm` adds tables,
 * strikethrough, task lists, and autolink literals on top of plain
 * react-markdown. No syntax highlighter is wired in - fenced code
 * still renders as a styled `<pre><code>` block, just not colourised
 * (avoids dragging in shiki / highlight.js + their language packs).
 */
const MARKDOWN_PLUGINS = [remarkGfm];

const AssistantMarkdown = ({ children }: { children: string }) => (
  <div
    className={cn(
      "prose prose-sm dark:prose-invert max-w-none break-words",
      "[&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-muted/60 [&_pre]:p-2",
      "[&_code]:rounded [&_code]:bg-muted/60 [&_code]:px-1 [&_code]:py-0.5",
      "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
      "[&_table]:w-full [&_table]:border-collapse [&_table]:my-2",
      "[&_th]:border [&_th]:border-border [&_th]:bg-muted/40 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left",
      "[&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_td]:align-top",
    )}
  >
    <Markdown remarkPlugins={MARKDOWN_PLUGINS}>{children}</Markdown>
  </div>
);

type AssistantBubbleProps = {
  message: UIMessage;
  isLast: boolean;
  status: ChatStatus;
  events?: ToolEvent[];
  regenerate?: () => void;
};

const AssistantBubble = ({
  message,
  isLast,
  status,
  events,
  regenerate,
}: AssistantBubbleProps) => {
  const reasoning = getReasoningText(message.parts);
  const isReasoningStreaming =
    isLast && status === "streaming" && message.parts.at(-1)?.type === "reasoning";
  const textParts = message.parts.filter(
    (p): p is { type: "text"; text: string } => p.type === "text",
  );
  const fullText = textParts.map((p) => p.text).join("");
  const hasText = fullText.length > 0;

  return (
    <Item className="items-start gap-3 border-none bg-transparent p-0">
      <ItemMedia>
        <RoleAvatar role="assistant" />
      </ItemMedia>
      <ItemContent className="gap-2">
        {reasoning && (
          <Collapsible defaultOpen={isReasoningStreaming}>
            <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ChevronDownIcon className="size-3" />
              <span>{isReasoningStreaming ? "thinking..." : "thoughts"}</span>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="mt-1 border-l-2 border-border/60 pl-3 text-xs text-muted-foreground whitespace-pre-wrap">
                {reasoning}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
        {events && events.length > 0 && <ToolEventList events={events} />}
        {hasText && <AssistantMarkdown>{fullText}</AssistantMarkdown>}
        {isLast && hasText && (
          <div className="flex items-center gap-1">
            {regenerate && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => regenerate()}
                  >
                    <RefreshCcwIcon className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Retry</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7"
                  onClick={() => navigator.clipboard.writeText(fullText)}
                >
                  <CopyIcon className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Copy</TooltipContent>
            </Tooltip>
          </div>
        )}
      </ItemContent>
    </Item>
  );
};

const UserBubble = ({ message }: { message: UIMessage }) => {
  const text = message.parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
  return (
    <Item className="items-start gap-3 border-none bg-transparent p-0">
      <ItemMedia>
        <RoleAvatar role="user" />
      </ItemMedia>
      <ItemContent>
        <div className="rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap">{text}</div>
      </ItemContent>
    </Item>
  );
};

/**
 * Sentinel for "no explicit model" in the Select. Radix's `SelectItem`
 * forbids an empty string `value`, so we map `""` <-> `__default__`
 * across the dropdown boundary.
 */
const DEFAULT_MODEL_VALUE = "__default__";

export const ChatView = ({
  messages,
  status,
  sendMessage,
  regenerate,
  suggestions = DEFAULT_SUGGESTIONS,
  toolEventsByMessage = {},
  models,
  model,
  onModelChange,
}: ChatViewProps) => {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);

  // Auto-scroll to bottom whenever a new chunk lands, but only while the
  // user is already pinned to the bottom. Lets them scroll up to read
  // history mid-stream without the view yanking them back.
  useEffect(() => {
    if (!isAtBottom || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, toolEventsByMessage, isAtBottom]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setIsAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX);
  };

  const scrollToBottom = () => {
    if (!scrollRef.current) return;
    scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    sendMessage({ text });
    setInput("");
  };

  const lastMessage = messages.at(-1);
  const lastEvents = lastMessage ? toolEventsByMessage[lastMessage.id] : undefined;
  const lastAssistantHasContent =
    lastMessage?.role === "assistant" &&
    (lastMessage.parts.some(
      (p) =>
        (p.type === "text" || p.type === "reasoning") &&
        Boolean((p as { text?: string }).text),
    ) ||
      (lastEvents?.length ?? 0) > 0);
  const isWaiting =
    (status === "submitted" || status === "streaming") && !lastAssistantHasContent;

  const showModelPicker = Boolean(
    models && models.length > 0 && onModelChange,
  );

  return (
    <TooltipProvider delayDuration={200}>
      <div className="mx-auto flex h-full max-w-4xl flex-col p-0 md:p-6">
        {showModelPicker && (
          <div className="flex items-center justify-end gap-2 px-4 pb-2 pt-1 text-xs text-muted-foreground">
            <span>Model</span>
            <Select
              value={model ? model : DEFAULT_MODEL_VALUE}
              onValueChange={(v) =>
                onModelChange?.(v === DEFAULT_MODEL_VALUE ? "" : v)
              }
            >
              <SelectTrigger size="sm" className="w-[260px]">
                <SelectValue placeholder="Server default" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_MODEL_VALUE}>
                  Server default
                </SelectItem>
                {models!.map((m) => (
                  <SelectItem key={m.name} value={m.name}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="relative flex-1 overflow-y-auto"
        >
          {messages.length === 0 ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessageSquareIcon className="size-5" />
                </EmptyMedia>
                <EmptyTitle>Start a conversation</EmptyTitle>
                <EmptyDescription>
                  Ask anything, or pick a suggestion below.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="flex flex-col gap-4 p-4">
              {messages.map((message, i) => {
                const isLast = i === messages.length - 1;
                if (message.role === "assistant") {
                  return (
                    <AssistantBubble
                      key={message.id}
                      message={message}
                      isLast={isLast}
                      status={status}
                      events={toolEventsByMessage[message.id]}
                      regenerate={regenerate}
                    />
                  );
                }
                return <UserBubble key={message.id} message={message} />;
              })}
              {isWaiting && (
                <div className="flex items-center gap-2 px-3 text-xs text-muted-foreground">
                  <Spinner className="size-3" />
                  <span className="animate-pulse">thinking...</span>
                </div>
              )}
            </div>
          )}
          {!isAtBottom && (
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={scrollToBottom}
              className="absolute bottom-2 left-1/2 -translate-x-1/2 rounded-full shadow"
            >
              <ArrowDownIcon className="size-4" />
            </Button>
          )}
        </div>

        {messages.length === 0 && suggestions.length > 0 && (
          <div className="flex flex-wrap gap-2 px-4 pb-2">
            {suggestions.map((s) => (
              <Button
                key={s}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => sendMessage({ text: s })}
              >
                {s}
              </Button>
            ))}
          </div>
        )}

        <form onSubmit={handleSubmit} className="px-4 pb-4 pt-2">
          <InputGroup>
            <InputGroupTextarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSubmit(e as unknown as React.FormEvent);
                }
              }}
              placeholder="Send a message..."
              rows={1}
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                type="submit"
                size="icon-sm"
                variant="default"
                disabled={!input.trim() || status === "streaming" || status === "submitted"}
              >
                {status === "streaming" || status === "submitted" ? (
                  <Spinner className="size-3" />
                ) : (
                  <SendIcon className="size-3" />
                )}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        </form>
      </div>
    </TooltipProvider>
  );
};
