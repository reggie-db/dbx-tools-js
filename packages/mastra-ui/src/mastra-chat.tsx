"use client";

import { useChat } from "@ai-sdk/react";
import type { MastraMemoryRef } from "@dbx-tools/appkit-mastra-shared";
import { DefaultChatTransport, type UIMessage } from "ai";
import { useMemo, type ReactNode } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "./ai-elements/conversation.js";
import { Loader } from "./ai-elements/loader.js";
import { Message, MessageContent } from "./ai-elements/message.js";
import { PromptInputControl } from "./ai-elements/prompt-input.js";
import { Response } from "./ai-elements/response.js";
import { Suggestion, Suggestions } from "./ai-elements/suggestion.js";
import { cn } from "./lib/utils.js";

// High-level chat component that wires the AI SDK v5 `useChat` hook to
// the AppKit-Mastra `POST /chat` route. The wire format is the same
// UI Message Stream that backs https://ui-dojo.mastra.ai/, so the
// underlying transport is just `DefaultChatTransport` from `ai`.
//
// The component is intentionally opinionated and minimal: title +
// description header, scrollable conversation, optional suggestion
// chips, and a textarea + submit row. Anything fancier (model picker,
// attachments, web-search toggle, ...) should compose the lower-level
// AI Elements primitives that this package re-exports.

export interface MastraChatProps {
  /** Path or absolute URL of the AppKit-Mastra `POST /chat` route.
   *  Defaults to the route the AppKit server plugin auto-mounts. */
  api?: string;
  /** Optional Mastra memory ref. Pass stable `{thread, resource}` ids
   *  if you want the agent to remember the conversation across reloads. */
  memory?: MastraMemoryRef;
  /** Initial UI messages to seed the chat. */
  initialMessages?: UIMessage[];
  /** Quick suggestion chips rendered when the conversation is empty. */
  suggestions?: string[];
  /** Title rendered above the conversation. */
  title?: string;
  /** One-line description rendered under the title. */
  description?: ReactNode;
  /** Empty state node rendered when there are no messages. */
  emptyState?: ReactNode;
  /** Optional extra class names for the outer wrapper. */
  className?: string;
}

export function MastraChat({
  api = "/api/appkit-mastra/chat",
  memory,
  initialMessages,
  suggestions,
  title = "Mastra agent",
  description,
  emptyState,
  className,
}: MastraChatProps) {
  // Stable transport instance: `useChat` memoizes off identity, so a
  // fresh `new DefaultChatTransport()` on every render would re-create
  // the connection each time. Inline body deps (the memory ref) flow
  // through `sendMessage`'s second argument instead.
  const transport = useMemo(
    () => new DefaultChatTransport({ api }),
    [api],
  );

  const { messages, sendMessage, status, stop, error } = useChat({
    transport,
    ...(initialMessages ? { messages: initialMessages } : {}),
  });

  const handleSubmit = (text: string) => {
    sendMessage(
      { text },
      memory ? { body: { memory } } : undefined,
    );
  };

  const handleSuggestionClick = (suggestion: string) => {
    sendMessage(
      { text: suggestion },
      memory ? { body: { memory } } : undefined,
    );
  };

  const isEmpty = messages.length === 0;

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col gap-3 bg-background text-foreground",
        className,
      )}
    >
      {(title || description) && (
        <header className="space-y-1 px-4 pt-4">
          {title && (
            <h1 className="font-semibold text-xl tracking-tight">{title}</h1>
          )}
          {description && (
            <p className="text-muted-foreground text-sm">{description}</p>
          )}
        </header>
      )}

      <Conversation className="min-h-0 flex-1">
        <ConversationContent className="space-y-3">
          {isEmpty
            ? (emptyState ?? (
                <ConversationEmptyState
                  title="No messages yet"
                  description="Send a message to start the conversation."
                />
              ))
            : messages.map((message) => (
                <ChatMessage key={message.id} message={message} />
              ))}
          {status === "submitted" && (
            <div className="px-2 py-1 text-muted-foreground">
              <Loader />
            </div>
          )}
          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-xs">
              <div className="font-semibold">Stream error</div>
              <pre className="mt-1 whitespace-pre-wrap break-all">
                {error.message}
              </pre>
            </div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="space-y-2 px-4 pb-4">
        {isEmpty && suggestions && suggestions.length > 0 && (
          <Suggestions>
            {suggestions.map((suggestion) => (
              <Suggestion
                key={suggestion}
                suggestion={suggestion}
                onClick={handleSuggestionClick}
              />
            ))}
          </Suggestions>
        )}
        <PromptInputControl
          onSubmit={handleSubmit}
          onStop={stop}
          status={status}
        />
      </div>
    </div>
  );
}

/** Renders a single UIMessage by walking its `parts` array and dispatching
 *  on `part.type`. AI SDK v5 messages no longer have a flat `content`
 *  string; everything is in `parts`. */
function ChatMessage({ message }: { message: UIMessage }) {
  return (
    <Message from={message.role}>
      <MessageContent>
        {message.parts.map((part, index) => {
          if (part.type === "text") {
            return <Response key={index}>{part.text}</Response>;
          }
          if (part.type === "reasoning") {
            return (
              <details
                key={index}
                className="rounded-md border bg-muted/30 px-2 py-1 text-xs"
              >
                <summary className="cursor-pointer text-muted-foreground">
                  Reasoning
                </summary>
                <div className="mt-1 whitespace-pre-wrap text-foreground">
                  {part.text}
                </div>
              </details>
            );
          }
          // Quietly drop tool/source/file parts for the minimal demo.
          // Consumers who want richer rendering can fork this component.
          return null;
        })}
      </MessageContent>
    </Message>
  );
}
