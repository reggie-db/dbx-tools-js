/**
 * Model-class classification for Databricks Model Serving endpoints.
 *
 * Chat capability bands are derived from the live workspace catalogue
 * rather than a hand-maintained table. Databricks publishes
 * per-endpoint `quality` / `speed` / `cost` scores (the AI Playground
 * bars) on the serving list; {@link classifyEndpoints} buckets scored
 * chat models into the chat {@link ModelClass} bands by the *relative*
 * distribution of those scores (quantiles, not fixed cut-offs) so a
 * brand-new model that lands outside today's score range still slots in
 * next to its peers. Embedding endpoints (`task === "llm/v1/embeddings"`)
 * are bucketed into {@link ModelClass.Embedding} by task, independent of
 * any score.
 *
 * Unscored-but-recognizable chat endpoints are still placed by a small
 * family heuristic ({@link classifyByFamily}) so a workspace whose
 * models predate Foundation Model API scoring keeps working. The
 * offline fallback floor - the hard-coded model list reached for when
 * the live catalogue can't be read at all - is a server concern and
 * lives in `@dbx-tools/model`, not here: a browser client never talks
 * to Databricks directly, so it has nothing to fall back to.
 *
 * Pure (no Node-only imports), so a client can classify a `/models`
 * response without server dependencies.
 */

import { ModelClass, type ServingEndpointSummary } from "./protocol.js";

/** Task hint Databricks stamps on chat completion endpoints. */
const CHAT_TASK = "llm/v1/chat";

/** Task hint Databricks stamps on embedding endpoints. */
const EMBEDDING_TASK = "llm/v1/embeddings";

/** Family-heuristic classification of a single endpoint name. */
export interface FamilyClass {
  /** Chat capability band the family maps to (never embedding). */
  class: ModelClass;
  /** Intra-family ordering hint (higher is newer / more capable). */
  rank: number;
}

/**
 * Numeric `[major, minor, patch]` version parsed from an endpoint
 * name, used to order siblings within a family/tier. Starts at the
 * first digit in the name, then reads successive separator-delimited,
 * digit-prefixed chunks as the three components (missing ones default
 * to `0`):
 *
 *   - `databricks-claude-opus-4-8`   -> `[4, 8, 0]`
 *   - `databricks-claude-opus-4-10`  -> `[4, 10, 0]` (sorts above 4-8)
 *   - `databricks-meta-llama-3-3-70b`-> `[3, 3, 70]`
 *   - `databricks-bge-large-en`      -> `[0, 0, 0]` (no digits)
 *
 * Component-wise comparison (not a decimal collapse) so `4.10` beats
 * `4.8` - the bug a `major + minor/10` score would hit.
 */
export function versionTuple(name: string): [number, number, number] {
  const start = name.search(/\d/);
  if (start < 0) return [0, 0, 0];
  const nums = name
    .slice(start)
    .split(/[^a-z0-9]+/i)
    .map((chunk) => chunk.match(/^\d+/)?.[0])
    .filter((digits): digits is string => digits !== undefined)
    .map(Number);
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
}

/** Compare two version tuples so the higher version sorts first (descending). */
function compareVersionDesc(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Monotonic version key for ordering siblings within a family/tier
 * (e.g. `opus-4-8` over `opus-4-7`). Encodes the {@link versionTuple}
 * as a single number so callers that need a scalar rank (the family
 * heuristic, the static fallback ordering) keep working; the encoding
 * preserves component order without the decimal-collapse bug.
 */
function versionScore(name: string): number {
  const [major, minor, patch] = versionTuple(name);
  return major * 1_000_000 + minor * 1_000 + patch;
}

/**
 * Best-effort chat capability band for an endpoint we have no live
 * score for, keyed off provider family and the well-known variant words
 * in the name (`opus`/`sonnet`/`haiku`, `pro`/`mini`/`nano`,
 * `flash`/`flash-lite`, Llama parameter sizes, etc). Returns `null` for
 * names we don't recognize so unknown custom endpoints are never
 * auto-selected as a default. The accompanying `rank` orders siblings
 * within a class. Only ever returns a chat band - embedding endpoints
 * are classified by task, not name.
 */
export function classifyByFamily(name: string): FamilyClass | null {
  const n = name.toLowerCase();
  const at = (cls: ModelClass): FamilyClass => ({ class: cls, rank: versionScore(n) });

  // Anthropic Claude
  if (n.includes("opus")) return at(ModelClass.ChatThinking);
  if (n.includes("sonnet")) return at(ModelClass.ChatBalanced);
  if (n.includes("haiku")) return at(ModelClass.ChatFast);

  // OpenAI open-weights (check before the generic gpt branch)
  if (n.includes("gpt-oss")) {
    return at(n.includes("120b") ? ModelClass.ChatBalanced : ModelClass.ChatFast);
  }
  // OpenAI GPT family
  if (n.includes("gpt")) {
    if (n.includes("pro")) return at(ModelClass.ChatThinking);
    if (n.includes("mini") || n.includes("nano")) return at(ModelClass.ChatFast);
    return at(ModelClass.ChatBalanced);
  }

  // Google Gemini / Gemma
  if (n.includes("gemini")) {
    if (n.includes("flash-lite")) return at(ModelClass.ChatFast);
    if (n.includes("pro")) return at(ModelClass.ChatThinking);
    return at(ModelClass.ChatBalanced);
  }
  if (n.includes("gemma")) return at(ModelClass.ChatFast);

  // Meta Llama
  if (n.includes("llama")) {
    if (n.includes("maverick") || n.includes("405b"))
      return at(ModelClass.ChatThinking);
    if (n.includes("70b")) return at(ModelClass.ChatBalanced);
    if (n.includes("8b") || n.includes("1b")) return at(ModelClass.ChatFast);
    return at(ModelClass.ChatBalanced);
  }

  // Alibaba Qwen
  if (n.includes("qwen")) return at(ModelClass.ChatBalanced);

  return null;
}

/** Linear-interpolated quantile of an ascending-sorted numeric array. */
function quantile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return Number.NaN;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo]!;
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * (idx - lo);
}

/** Internal sortable wrapper carrying the ordering keys for a bucket entry. */
interface Ranked {
  ep: ServingEndpointSummary;
  /** Quality (scored) or family version (unscored) - higher first. */
  sort: number;
  /** Scored endpoints rank ahead of family-only guesses. */
  scored: boolean;
  tieCost: number;
  tieSpeed: number;
  /** Parsed name version, the final tie-breaker (newer sibling first). */
  version: readonly number[];
}

function rankOrder(a: Ranked, b: Ranked): number {
  if (a.scored !== b.scored) return a.scored ? -1 : 1;
  if (b.sort !== a.sort) return b.sort - a.sort;
  if (a.tieCost !== b.tieCost) return a.tieCost - b.tieCost;
  if (b.tieSpeed !== a.tieSpeed) return b.tieSpeed - a.tieSpeed;
  // Same scored-ness, quality, cost, and speed (e.g. several Claude
  // Opus point releases): prefer the newer parsed version so
  // `opus-4-8` beats `opus-4-7`.
  return compareVersionDesc(a.version, b.version);
}

/**
 * Bucket live endpoints into {@link ModelClass}es, ranked best-first
 * within each chat band.
 *
 * Embedding endpoints (`task === "llm/v1/embeddings"`) go into
 * {@link ModelClass.Embedding} by task, in listing order (they carry no
 * capability score to rank on).
 *
 * Chat endpoints (`task === "llm/v1/chat"`) split into the three chat
 * bands. Scored endpoints (those carrying a `profile.quality`) drive
 * the banding: the observed quality distribution is split at its 1/3
 * and 2/3 quantiles, so the top third is {@link ModelClass.ChatThinking},
 * the bottom third {@link ModelClass.ChatFast}, and the middle
 * {@link ModelClass.ChatBalanced}. Because the thresholds come from the
 * data, the split adapts as Databricks adds or rescores models -
 * nothing is pinned to a fixed score band.
 *
 * Unscored chat endpoints are placed by {@link classifyByFamily} and
 * ranked after the scored ones in their band; unrecognized, unscored
 * endpoints (e.g. custom external models) are omitted entirely so they
 * are never picked as an automatic default.
 *
 * Within a chat band, scored models sort by `quality` desc, then `cost`
 * asc, then `speed` desc, then parsed name version desc; family-only
 * models sort by version rank then parsed version. The version
 * tie-break ({@link versionTuple}) is what separates point releases
 * that share a score profile (e.g. `opus-4-8` ahead of `opus-4-7`).
 */
export function classifyEndpoints(
  endpoints: readonly ServingEndpointSummary[],
): Record<ModelClass, ServingEndpointSummary[]> {
  const chat = endpoints.filter((e) => e.task === CHAT_TASK);
  const qualities = chat
    .map((e) => e.profile?.quality)
    .filter((q): q is number => Number.isFinite(q))
    .sort((a, b) => a - b);
  const low = quantile(qualities, 1 / 3);
  const high = quantile(qualities, 2 / 3);

  const buckets: Record<ModelClass, Ranked[]> = {
    [ModelClass.ChatThinking]: [],
    [ModelClass.ChatBalanced]: [],
    [ModelClass.ChatFast]: [],
    [ModelClass.Embedding]: [],
  };

  for (const ep of chat) {
    const q = ep.profile?.quality;
    if (Number.isFinite(q)) {
      const quality = q as number;
      const cls =
        quality >= high
          ? ModelClass.ChatThinking
          : quality <= low
            ? ModelClass.ChatFast
            : ModelClass.ChatBalanced;
      buckets[cls].push({
        ep,
        sort: quality,
        scored: true,
        tieCost: ep.profile?.cost ?? Number.POSITIVE_INFINITY,
        tieSpeed: ep.profile?.speed ?? 0,
        version: versionTuple(ep.name),
      });
      continue;
    }
    const family = classifyByFamily(ep.name);
    if (!family) continue;
    buckets[family.class].push({
      ep,
      sort: family.rank,
      scored: false,
      tieCost: Number.POSITIVE_INFINITY,
      tieSpeed: 0,
      version: versionTuple(ep.name),
    });
  }

  // Embeddings are bucketed by task in listing order - no score to rank.
  const embeddings = endpoints.filter((e) => e.task === EMBEDDING_TASK);

  return {
    [ModelClass.ChatThinking]: buckets[ModelClass.ChatThinking]
      .sort(rankOrder)
      .map((x) => x.ep),
    [ModelClass.ChatBalanced]: buckets[ModelClass.ChatBalanced]
      .sort(rankOrder)
      .map((x) => x.ep),
    [ModelClass.ChatFast]: buckets[ModelClass.ChatFast]
      .sort(rankOrder)
      .map((x) => x.ep),
    [ModelClass.Embedding]: embeddings,
  };
}
