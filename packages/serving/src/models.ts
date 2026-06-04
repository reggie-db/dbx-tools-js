import { apiUtils } from "@dbx-tools/appkit-shared";

// ────────────────────────────────────────────────────────────────
// Endpoint shape
// ────────────────────────────────────────────────────────────────

/**
 * Minimal local subset of a Databricks `/serving-endpoints` entry.
 * Just the fields the ranker reads: top-level `name` + the nested
 * Foundation Model record under `config.served_entities[0]
 * .foundation_model`, which is where `model_class` and the AI
 * Gateway profile (speed / quality / cost) live.
 *
 * We deliberately do not extend `serving.ServingEndpoint` from
 * `@databricks/sdk-experimental` - the SDK's `FoundationModel`
 * doesn't declare `model_class` / `ai_gateway_model_profile`
 * (the API surfaces them but the SDK types lag), so extending
 * gains nothing and adds noise. Keep this hand-rolled and tight.
 */

interface AiGatewayModelProfileBase {
  speed?: number;
  quality?: number;
  cost?: number;
}

type AiGatewayModelProfile = Omit<
  AiGatewayModelProfileBase,
  "speed" | "quality" | "cost"
> & {
  speed: number;
  quality: number;
  cost: number;
};

export interface FoundationModel {
  model_class?: string;
  ai_gateway_model_profile?: AiGatewayModelProfileBase;
}

export interface ServingEndpoint extends Record<string, unknown> {
  name: string;
  config?: {
    served_entities?: {
      foundation_model?: FoundationModel;
    }[];
  };
}

/**
 * Best-effort sortable version string derived from the endpoint's
 * `name`. Returns `undefined` for non-FOUNDATION_MODEL endpoints or
 * names that contain no digit chunks.
 *
 * Each `<digits>[<letters>]` chunk in the name contributes its
 * numeric prefix to the version (up to 3 slots, MAJOR.MINOR.PATCH).
 * Chunks with trailing letters - and any overflow chunks past the
 * 3rd - contribute their full form to a 4th dotted component. So
 * `databricks-claude-opus-4-7` is `"4.7.0"`,
 * `databricks-gpt-oss-120b` is `"120.0.0.120b"`, and
 * `databricks-bge-large-en` (no digits) is `undefined`.
 */
export function foundationModelVersion(endpoint: ServingEndpoint): string | undefined {
  if (!foundationModels(endpoint).next().value) return undefined;
  // Pull all `<digits>[<letters>]` runs out of the endpoint name.
  const input = endpoint.name.match(/(\d+)(.*)$/)?.[0];
  if (!input) return undefined;
  const chunks: { num: number; suffix?: string }[] = input
    .split(/[^a-z0-9]+/i)
    .flatMap((part) => {
      const numPart = part.match(/\d+/)?.[0];
      return numPart
        ? [
            {
              num: parseInt(numPart),
              suffix: numPart.length !== part.length ? part : undefined,
            },
          ]
        : [];
    });
  if (!chunks.length) return undefined;
  // Each chunk contributes its numeric prefix to versionParts (up to
  // 3 slots = MAJOR.MINOR.PATCH). Chunks that carry trailing letters,
  // plus any overflow chunks past the 3rd, contribute their *full*
  // form to suffixParts, which is joined and tacked on as a 4th
  // dotted component.
  const versionParts: any[] = [];
  const suffixParts: any[] = [];
  for (const { num, suffix } of chunks) {
    if (versionParts.length < 3) {
      versionParts.push(num);
      if (!suffix) {
        continue;
      }
    }
    suffixParts.push(suffix || num);
  }
  if (versionParts.length || suffixParts.length) {
    if (!versionParts.length) {
      versionParts.push(...[0, 0, 1]);
    } else {
      while (versionParts.length < 3) {
        versionParts.push(0);
      }
    }

    if (suffixParts.length) versionParts.push(suffixParts.join(""));
    return versionParts.join(".");
  }
  return undefined;
}

/**
 * Iterate every `served_entities[*].foundation_model` record on
 * `endpoint` whose entity `type` is `"FOUNDATION_MODEL"`. Most
 * Databricks-hosted Foundation Model endpoints have exactly one
 * served entity, but the schema is `[]` so this stays a generator.
 */
export function* foundationModels(
  endpoint: ServingEndpoint,
): Generator<FoundationModel> {
  const servedEntities = (endpoint as any).config?.served_entities?.filter(
    (servedEntity: any) => servedEntity?.type === "FOUNDATION_MODEL",
  );
  if (servedEntities) {
    for (const entity of servedEntities) {
      const foundationModel = entity.foundation_model;
      if (foundationModel) yield foundationModel;
    }
  }
}

/**
 * First non-empty `model_class` (e.g. `"claude"`, `"gpt-oss"`,
 * `"gemini"`) from the endpoint's served entities, or `undefined`
 * when none of them have one set.
 */
export const foundationModelClass = (endpoint: ServingEndpoint): string | undefined =>
  foundationModelClasses(endpoint).next().value;

/**
 * Iterate every `model_class` declared by the endpoint's served
 * Foundation Models. Skips entities whose `model_class` is unset.
 */
export function* foundationModelClasses(endpoint: ServingEndpoint): Generator<string> {
  for (const foundationModel of foundationModels(endpoint)) {
    const modelClass = foundationModel.model_class;
    if (modelClass) yield modelClass;
  }
}

/**
 * First non-empty `ai_gateway_model_profile` (`{ speed, quality, cost }`)
 * from the endpoint's served entities, with each axis defaulted to
 * `0` so callers don't have to null-check before sorting. Returns
 * `undefined` when no profile has any of the three fields set.
 */
export const foundationModelProfile = (
  endpoint: ServingEndpoint,
): AiGatewayModelProfile | undefined => foundationModelProfiles(endpoint).next().value;

/**
 * Iterate every `ai_gateway_model_profile` on the endpoint's served
 * Foundation Models that has at least one numeric axis set. Each
 * yielded profile has `speed`, `quality`, and `cost` filled in (zero
 * when the upstream record omitted them) so a downstream ranker can
 * sort without per-axis null checks.
 */
export function* foundationModelProfiles(
  endpoint: ServingEndpoint,
): Generator<AiGatewayModelProfile> {
  for (const foundationModel of foundationModels(endpoint)) {
    const profile = foundationModel.ai_gateway_model_profile;
    if (
      profile &&
      [profile.speed, profile.quality, profile.cost].some(Number.isFinite)
    ) {
      yield {
        speed: 0,
        quality: 0,
        cost: 0,
        ...profile,
      };
    }
  }
}

/**
 * Fetch every serving endpoint visible to the caller via
 * `/api/2.0/serving-endpoints`. Goes through
 * {@link apiUtils.fetchApi}, which pulls the workspace client out
 * of the active AppKit execution context (so OBO auth is respected
 * when called inside a per-request scope) and parses the JSON
 * response.
 *
 * Must be called inside an initialized AppKit app -
 * {@link apiUtils.fetchApi} dereferences `getExecutionContext()`
 * for the workspace client, which throws if `createApp(...)` hasn't
 * run yet. Tests that don't want to bootstrap AppKit should mock
 * this function or feed a fixture directly into the consumer (see
 * `packages/serving/test/models.test.ts` for the inline-JSON
 * pattern).
 *
 * No per-user cache layer today - the call is intentionally
 * uncached so newly-created endpoints show up immediately. Wrap
 * with {@link apiUtils.fetchApi}'s cache hook on the caller side
 * if you want TTL'd results.
 */
export async function servingEndpoints(): Promise<ServingEndpoint[]> {
  const data = await apiUtils.fetchApi<{ endpoints?: ServingEndpoint[] }>(
    "serving-endpoints",
  );
  return data?.endpoints ?? [];
}
