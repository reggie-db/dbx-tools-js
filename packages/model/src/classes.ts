/**
 * Model-class ordering for the model service.
 *
 * `@dbx-tools/model-shared` declares the {@link ModelClass} values and
 * their schema; the *behavior* over those values - the chat capability
 * order, the "this class and below" ceiling, and coercing loose request
 * input to a class - lives here in the service so the shared
 * wire-format surface stays purely declarative.
 */

import { ModelClass, ModelClassSchema } from "@dbx-tools/model-shared";

/**
 * Chat capability ladder in descending order - most capable
 * ({@link ModelClass.ChatThinking}) first, least
 * ({@link ModelClass.ChatFast}) last. {@link ModelClass.Embedding} is a
 * separate modality and is deliberately absent: the ceiling never spans
 * it. This is the order used to filter "this class and below" and to
 * break ranking ties toward the more capable model.
 */
export const CHAT_CLASS_ORDER: readonly ModelClass[] = [
  ModelClass.ChatThinking,
  ModelClass.ChatBalanced,
  ModelClass.ChatFast,
];

/**
 * Every class in display order: the chat ladder followed by
 * {@link ModelClass.Embedding}. Used when flattening a full
 * classification (e.g. stamping the class onto each cached endpoint).
 */
export const MODEL_CLASS_ORDER: readonly ModelClass[] = [
  ...CHAT_CLASS_ORDER,
  ModelClass.Embedding,
];

/** Whether `cls` is one of the chat capability bands (vs. embedding). */
export function isChatClass(cls: ModelClass): boolean {
  return CHAT_CLASS_ORDER.includes(cls);
}

/**
 * Coerce an arbitrary value (query string, header, body field) to a
 * {@link ModelClass}, returning `null` when it isn't a known class.
 * Lets a route accept a class request without throwing on junk input.
 *
 * Matches the full slug first (`"chat-fast"`, `"embedding"`), then -
 * for a bare chat band - retries with a `chat-` prefix, so the shorthand
 * `"thinking"` / `"balanced"` / `"fast"` resolves to the corresponding
 * `chat-*` class.
 */
export function parseModelClass(value: unknown): ModelClass | null {
  const exact = ModelClassSchema.safeParse(value);
  if (exact.success) return exact.data;
  const prefixed = ModelClassSchema.safeParse(`chat-${value}`);
  return prefixed.success ? prefixed.data : null;
}

/**
 * Classes at or below `cls` in chat capability: the class itself plus
 * every less-capable chat band, in {@link CHAT_CLASS_ORDER}. Treats a
 * chat `cls` as a ceiling - requesting {@link ModelClass.ChatBalanced}
 * yields `[ChatBalanced, ChatFast]`, never
 * {@link ModelClass.ChatThinking} - so a class ask can degrade downward
 * to a smaller chat model but never escalate to a larger one.
 *
 * {@link ModelClass.Embedding} is its own modality, not a rung on the
 * chat ladder, so it yields just `[Embedding]`. An unrecognized class
 * yields the full chat ladder.
 */
export function classesAtOrBelow(cls: ModelClass): ModelClass[] {
  if (cls === ModelClass.Embedding) return [ModelClass.Embedding];
  const index = CHAT_CLASS_ORDER.indexOf(cls);
  return index < 0 ? [...CHAT_CLASS_ORDER] : [...CHAT_CLASS_ORDER.slice(index)];
}
