/**
 * Server-side offline fallback opinion for model selection.
 *
 * When the live `/serving-endpoints` catalogue can't be read at all -
 * no user token, the service principal can't list, or the workspace is
 * unreachable - the resolver still has to name *some* endpoint. This
 * module holds that floor: a small, hard-coded set of well-known
 * Foundation Model API endpoint names, each bucketed into a chat
 * {@link ModelClass} by the shared {@link classifyByFamily} heuristic
 * (no classes are hard-coded here) and ordered best-first.
 *
 * This is deliberately *server-only*. A browser client never talks to
 * Databricks directly - it always goes through this server - so it has
 * nothing to fall back to and must not assume a stale, baked-in model
 * list; it consumes the live `/models` response instead. The pure
 * classifier ({@link classifyEndpoints}) is what the client shares.
 */

import {
  classifyByFamily,
  type FamilyClass,
  ModelClass,
} from "@dbx-tools/model-shared";

/**
 * Small, last-resort set of well-known Foundation Model API endpoint
 * names, ordered best-first within each class by {@link classifyByFamily}.
 * Used only as the floor when the live `/serving-endpoints` catalogue
 * can't be read at resolve time; the live, score-driven classification
 * supersedes it whenever the workspace listing is available. Classes are
 * not hard-coded here - each name is classified by family heuristic.
 */
const FALLBACK_MODEL_NAMES: readonly string[] = [
  "databricks-claude-opus-4-8",
  "databricks-gpt-5-5-pro",
  "databricks-gemini-3-1-pro",
  "databricks-claude-sonnet-4-6",
  "databricks-gpt-5-5",
  "databricks-meta-llama-3-3-70b-instruct",
  "databricks-claude-haiku-4-5",
  "databricks-gpt-5-nano",
  "databricks-meta-llama-3-1-8b-instruct",
];

/**
 * Static fallback model ids for a chat class, drawn from the small
 * built-in {@link FALLBACK_MODEL_NAMES} list and ordered best-first by
 * family rank. Sync and workspace-independent: this is the *fallback
 * opinion* used to seed default lists or when the live catalogue is
 * unreachable - live resolution prefers `classifyEndpoints`. Returns
 * `[]` for {@link ModelClass.Embedding} (the floor is chat-only).
 */
export function modelsForClass(cls: ModelClass): readonly string[] {
  return FALLBACK_MODEL_NAMES.map((name) => ({ name, c: classifyByFamily(name) }))
    .filter(
      (x): x is { name: string; c: FamilyClass } => x.c !== null && x.c.class === cls,
    )
    .sort((a, b) => b.c.rank - a.c.rank)
    .map((x) => x.name);
}

/** Top static fallback model id for a chat class. */
export function modelForClass(cls: ModelClass): string {
  return modelsForClass(cls)[0]!;
}

/**
 * Priority-ordered fallback chain (ChatThinking -> ChatBalanced ->
 * ChatFast) over the small built-in list. The floor walked at resolve
 * time when no agent / plugin / env / request model is set *and* the
 * live catalogue yields nothing.
 */
export const FALLBACK_MODEL_IDS: readonly string[] = [
  ...modelsForClass(ModelClass.ChatThinking),
  ...modelsForClass(ModelClass.ChatBalanced),
  ...modelsForClass(ModelClass.ChatFast),
];
