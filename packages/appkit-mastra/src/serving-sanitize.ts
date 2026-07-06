/**
 * Repairs Mastra / AI SDK message replays sent to Databricks Model
 * Serving before they hit the OpenAI-compatible `/chat/completions`
 * route.
 */

import { stringUtils } from "@dbx-tools/shared";

/**
 * OpenAI-flavoured chat message shape we need to mutate. We do not
 * import the OpenAI / AI SDK types because both packages keep these
 * fields under internal namespaces; the wire payload is the contract
 * here and it's stable enough to inline.
 */
export interface ServingChatMessage {
  role: "system" | "user" | "assistant" | "tool" | "reasoning";
  content?: string | ServingContentPart[];
  tool_calls?: Array<{ id: string; type: string; function: unknown }>;
  tool_call_id?: string;
  reasoning?: unknown;
  reasoning_content?: unknown;
}

type ServingContentPart = {
  type?: string;
  text?: string;
  [key: string]: unknown;
};

const REASONING_PART_TYPES = new Set([
  "reasoning",
  "thinking",
  "redacted_thinking",
]);

/**
 * Parse, sanitize, and re-serialize a `/serving-endpoints/...` POST
 * body. Returns the original string verbatim when the body is not
 * JSON, has no `messages`, or no rewrite was needed.
 */
export function rewriteServingBody(body: string): string {
  let parsed: { messages?: unknown };
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  if (!Array.isArray(parsed.messages)) return body;
  const messages = parsed.messages as ServingChatMessage[];
  const changed =
    stripReasoningFromServingMessages(messages) ||
    repairAssistantPrefill(messages);
  return changed ? JSON.stringify(parsed) : body;
}

/**
 * Drop extended-thinking / reasoning blocks from a replayed transcript.
 *
 * Hybrid Claude endpoints (e.g. Sonnet 4.5+) may emit `reasoning` content
 * parts on the first turn. Mastra persists and replays them on the next
 * agent step, but Databricks-hosted Claude rejects those blocks on
 * multi-turn tool continuations. The UI already captured reasoning for
 * display; stripping here keeps provider replay compatible without
 * changing what users see in the chat bubble.
 */
export function stripReasoningFromServingMessages(
  messages: ServingChatMessage[],
): boolean {
  let changed = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role === "reasoning") {
      messages.splice(i, 1);
      changed = true;
      continue;
    }
    if (msg.reasoning !== undefined) {
      delete msg.reasoning;
      changed = true;
    }
    if (msg.reasoning_content !== undefined) {
      delete msg.reasoning_content;
      changed = true;
    }
    if (!Array.isArray(msg.content)) continue;
    const filtered = msg.content.filter((part) => {
      const type = part?.type;
      if (typeof type === "string" && REASONING_PART_TYPES.has(type)) {
        changed = true;
        return false;
      }
      return true;
    });
    if (filtered.length !== msg.content.length) {
      msg.content = filtered;
    }
    const hasToolCalls =
      Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    if (
      msg.role === "assistant" &&
      !hasToolCalls &&
      isEmptyServingContent(msg.content)
    ) {
      messages.splice(i, 1);
      changed = true;
    }
  }
  return changed;
}

/**
 * Repair a Mastra/AI SDK message replay that Databricks-hosted Claude
 * rejects with `"This model does not support assistant message
 * prefill. The conversation must end with a user message."`.
 *
 * The bug pattern: when an assistant turn streams text *and* a
 * `tool_call`, the AI SDK persists them as two separate assistant
 * entries (text-only and tool-call-only). On the next agent step the
 * tool-call entry is replayed *before* the tool result and the
 * text entry is replayed *after* it, so the conversation ends with a
 * trailing assistant text message. Anthropic interprets that as a
 * prefill request and rejects it on Databricks (the upstream Bedrock
 * route disallows prefill).
 *
 * Fix: when the last message is an assistant text with no `tool_calls`
 * and the chain immediately before it is `assistant(tool_calls=...)`
 * followed only by `tool(...)` results, fold the trailing text back
 * into the `content` of that opening assistant and drop the duplicate.
 */
export function repairAssistantPrefill(messages: ServingChatMessage[]): boolean {
  if (messages.length < 2) return false;
  const last = messages[messages.length - 1];
  if (
    !last ||
    last.role !== "assistant" ||
    (last.tool_calls && last.tool_calls.length > 0)
  ) {
    return false;
  }

  let i = messages.length - 2;
  while (i >= 0 && messages[i]?.role === "tool") i--;
  if (i < 0) return false;
  const opener = messages[i];
  if (
    !opener ||
    opener.role !== "assistant" ||
    !opener.tool_calls ||
    opener.tool_calls.length === 0
  ) {
    return false;
  }

  const merged = [
    stringUtils.trimToNull(textFromServingContent(opener.content)),
    stringUtils.trimToNull(textFromServingContent(last.content)),
  ]
    .filter((s): s is string => s !== null)
    .join("\n\n");
  opener.content = merged;
  messages.pop();
  return true;
}

function textFromServingContent(content: ServingChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n\n");
}

function isEmptyServingContent(content: ServingChatMessage["content"]): boolean {
  if (content === undefined) return true;
  if (typeof content === "string") return content.trim().length === 0;
  if (!Array.isArray(content)) return true;
  return content.every((part) => {
    if (part?.type === "text") {
      return typeof part.text !== "string" || part.text.trim().length === 0;
    }
    return false;
  });
}
