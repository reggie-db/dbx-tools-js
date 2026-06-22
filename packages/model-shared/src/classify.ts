/**
 * Capability-tier classification for Databricks Model Serving
 * endpoints.
 *
 * Tiers are derived from the live workspace catalogue rather than a
 * hand-maintained table. Databricks publishes per-endpoint
 * `quality` / `speed` / `cost` scores (the AI Playground bars) on the
 * serving list; {@link classifyEndpoints} buckets scored chat models
 * into {@link ModelTier}s by the *relative* distribution of those
 * scores (quantiles, not fixed cut-offs) so a brand-new model that
 * lands outside today's score range still slots in next to its peers.
 *
 * Unscored-but-recognizable endpoints are still placed by a small
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

import { ModelTier, type ServingEndpointSummary } from "./protocol.js";

/** Task hint Databricks stamps on chat completion endpoints. */
const CHAT_TASK = "llm/v1/chat";

/** Family-heuristic classification of a single endpoint name. */
export interface FamilyClass {
  tier: ModelTier;
  /** Intra-family ordering hint (higher is newer / more capable). */
  rank: number;
}

/**
 * Crude version score from the digits in an endpoint name, used only
 * to order siblings within a family/tier (e.g. `opus-4-8` over
 * `opus-4-1`). Reads the first two numeric groups as `major.minor`;
 * parameter-count suffixes like `70b` only ever compete inside their
 * own family bucket, so their magnitude is harmless.
 */
function versionScore(name: string): number {
  const groups = name.match(/\d+/g);
  if (!groups || groups.length === 0) return 0;
  const major = Number(groups[0]);
  const minor = groups[1] !== undefined ? Number(groups[1]) : 0;
  return major + minor / 10;
}

/**
 * Best-effort tier for an endpoint we have no live score for, keyed
 * off provider family and the well-known variant words in the name
 * (`opus`/`sonnet`/`haiku`, `pro`/`mini`/`nano`, `flash`/`flash-lite`,
 * Llama parameter sizes, etc). Returns `null` for names we don't
 * recognize so unknown custom endpoints are never auto-selected as a
 * default. The accompanying `rank` orders siblings within a tier.
 */
export function classifyByFamily(name: string): FamilyClass | null {
  const n = name.toLowerCase();
  const at = (tier: ModelTier): FamilyClass => ({ tier, rank: versionScore(n) });

  // Anthropic Claude
  if (n.includes("opus")) return at(ModelTier.Thinking);
  if (n.includes("sonnet")) return at(ModelTier.Balanced);
  if (n.includes("haiku")) return at(ModelTier.Fast);

  // OpenAI open-weights (check before the generic gpt branch)
  if (n.includes("gpt-oss")) {
    return at(n.includes("120b") ? ModelTier.Balanced : ModelTier.Fast);
  }
  // OpenAI GPT family
  if (n.includes("gpt")) {
    if (n.includes("pro")) return at(ModelTier.Thinking);
    if (n.includes("mini") || n.includes("nano")) return at(ModelTier.Fast);
    return at(ModelTier.Balanced);
  }

  // Google Gemini / Gemma
  if (n.includes("gemini")) {
    if (n.includes("flash-lite")) return at(ModelTier.Fast);
    if (n.includes("pro")) return at(ModelTier.Thinking);
    return at(ModelTier.Balanced);
  }
  if (n.includes("gemma")) return at(ModelTier.Fast);

  // Meta Llama
  if (n.includes("llama")) {
    if (n.includes("maverick") || n.includes("405b")) return at(ModelTier.Thinking);
    if (n.includes("70b")) return at(ModelTier.Balanced);
    if (n.includes("8b") || n.includes("1b")) return at(ModelTier.Fast);
    return at(ModelTier.Balanced);
  }

  // Alibaba Qwen
  if (n.includes("qwen")) return at(ModelTier.Balanced);

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
}

function rankOrder(a: Ranked, b: Ranked): number {
  if (a.scored !== b.scored) return a.scored ? -1 : 1;
  if (b.sort !== a.sort) return b.sort - a.sort;
  if (a.tieCost !== b.tieCost) return a.tieCost - b.tieCost;
  return b.tieSpeed - a.tieSpeed;
}

/**
 * Bucket live chat endpoints into capability tiers, ranked best-first
 * within each tier.
 *
 * Scored endpoints (those carrying a `profile.quality`) drive the
 * tiering: the observed quality distribution is split at its 1/3 and
 * 2/3 quantiles, so the top third is {@link ModelTier.Thinking}, the
 * bottom third {@link ModelTier.Fast}, and the middle
 * {@link ModelTier.Balanced}. Because the thresholds come from the
 * data, the split adapts as Databricks adds or rescores models -
 * nothing is pinned to a fixed score band.
 *
 * Unscored endpoints are placed by {@link classifyByFamily} and ranked
 * after the scored ones in their tier; unrecognized, unscored
 * endpoints (e.g. custom external models) are omitted entirely so they
 * are never picked as an automatic default. Non-chat endpoints
 * (embeddings) are excluded.
 *
 * Within a tier, scored models sort by `quality` desc, then `cost`
 * asc, then `speed` desc; family-only models sort by version rank.
 */
export function classifyEndpoints(
  endpoints: readonly ServingEndpointSummary[],
): Record<ModelTier, ServingEndpointSummary[]> {
  const chat = endpoints.filter((e) => e.task === CHAT_TASK);
  const qualities = chat
    .map((e) => e.profile?.quality)
    .filter((q): q is number => Number.isFinite(q))
    .sort((a, b) => a - b);
  const low = quantile(qualities, 1 / 3);
  const high = quantile(qualities, 2 / 3);

  const buckets: Record<ModelTier, Ranked[]> = {
    [ModelTier.Thinking]: [],
    [ModelTier.Balanced]: [],
    [ModelTier.Fast]: [],
  };

  for (const ep of chat) {
    const q = ep.profile?.quality;
    if (Number.isFinite(q)) {
      const quality = q as number;
      const tier =
        quality >= high
          ? ModelTier.Thinking
          : quality <= low
            ? ModelTier.Fast
            : ModelTier.Balanced;
      buckets[tier].push({
        ep,
        sort: quality,
        scored: true,
        tieCost: ep.profile?.cost ?? Number.POSITIVE_INFINITY,
        tieSpeed: ep.profile?.speed ?? 0,
      });
      continue;
    }
    const family = classifyByFamily(ep.name);
    if (!family) continue;
    buckets[family.tier].push({
      ep,
      sort: family.rank,
      scored: false,
      tieCost: Number.POSITIVE_INFINITY,
      tieSpeed: 0,
    });
  }

  return {
    [ModelTier.Thinking]: buckets[ModelTier.Thinking].sort(rankOrder).map((x) => x.ep),
    [ModelTier.Balanced]: buckets[ModelTier.Balanced].sort(rankOrder).map((x) => x.ep),
    [ModelTier.Fast]: buckets[ModelTier.Fast].sort(rankOrder).map((x) => x.ep),
  };
}
