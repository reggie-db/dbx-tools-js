import type { ToolEvent, ToolProgress } from "./types.js";

// Suggested follow-up question extraction: dedupe + cap the
// `suggested_questions` events Genie tools emit so the assistant
// bubble surfaces a short, varied list of next questions.

/**
 * Hard cap on how many suggested follow-ups surface under one
 * assistant message - several Genie queries each emitting a handful
 * would otherwise flood the bubble.
 */
const MAX_SUGGESTIONS = 4;

/**
 * Token-set Jaccard threshold above which two suggestions are treated
 * as the same question and the later one is dropped. Tuned to fold
 * trivial rewordings ("Show me revenue by region" vs "Show revenue by
 * region") while keeping genuinely distinct questions that happen to
 * share filler words.
 */
const SUGGESTION_SIMILARITY = 0.6;

/** Lowercased, punctuation-stripped word set used for similarity comparison. */
function suggestionTokens(question: string): Set<string> {
  return new Set(
    question
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

/** Jaccard similarity (0..1) of two token sets; 0 when either is empty. */
function tokenSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

/**
 * Dedupe + cap an ordered list of question lists into the short,
 * varied list the UI renders. Each inner list is one source's ordered
 * questions; we round-robin by position so every source contributes
 * its *top* question before any source contributes a second -
 * favoring breadth over depth. Near-duplicates (see
 * {@link SUGGESTION_SIMILARITY}) are skipped and the result is capped
 * at {@link MAX_SUGGESTIONS}. Exact-duplicate questions across
 * sources also fold via the similarity check.
 */
function pickSuggestions(lists: string[][]): string[] {
  const accepted: string[] = [];
  const acceptedTokens: Set<string>[] = [];
  const consider = (question: string): void => {
    if (accepted.length >= MAX_SUGGESTIONS) return;
    const tokens = suggestionTokens(question);
    if (tokens.size === 0) return;
    const isDuplicate = acceptedTokens.some(
      (t) => tokenSimilarity(t, tokens) >= SUGGESTION_SIMILARITY,
    );
    if (isDuplicate) return;
    accepted.push(question);
    acceptedTokens.push(tokens);
  };

  const maxLen = lists.reduce((m, l) => Math.max(m, l.length), 0);
  for (let i = 0; i < maxLen && accepted.length < MAX_SUGGESTIONS; i++) {
    for (const list of lists) {
      const question = list[i];
      if (question !== undefined) consider(question);
    }
  }
  return accepted;
}

/**
 * Dedupe + cap a single flat list of suggested questions (e.g. the
 * initial Genie sample questions). Shares the similarity dedupe and
 * {@link MAX_SUGGESTIONS} cap with the follow-up extractor so initial
 * and follow-up suggestions behave identically.
 */
export const dedupeSuggestions = (questions: string[] | undefined): string[] =>
  questions && questions.length > 0 ? pickSuggestions([questions]) : [];

/**
 * Build the short, deduped list of suggested follow-up questions for
 * an assistant message. Within each tool event the **last**
 * `suggested` progress entry wins (Genie publishes an evolving list;
 * the final one is the refined version). Delegates dedupe + cap to
 * {@link pickSuggestions}.
 */
export const collectSuggestions = (events: ToolEvent[] | undefined): string[] => {
  if (!events || events.length === 0) return [];

  // One ordered question list per event that emitted any.
  const lists: string[][] = [];
  for (const event of events) {
    const last = [...(event.progress ?? [])]
      .reverse()
      .find(
        (p): p is Extract<ToolProgress, { type: "suggested_questions" }> =>
          p.type === "suggested_questions",
      );
    if (last && last.questions.length > 0) lists.push(last.questions);
  }

  return pickSuggestions(lists);
};
