import { getExecutionContext } from "@databricks/appkit";
import { WorkspaceClient } from "@databricks/sdk-experimental";
import { httpUtils } from "@dbx-tools/appkit-shared";

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

export const foundationModelClass = (endpoint: ServingEndpoint): string | undefined =>
  foundationModelClasses(endpoint).next().value;

export function* foundationModelClasses(endpoint: ServingEndpoint): Generator<string> {
  for (const foundationModel of foundationModels(endpoint)) {
    const modelClass = foundationModel.model_class;
    if (modelClass) yield modelClass;
  }
}

export const foundationModelProfile = (
  endpoint: ServingEndpoint,
): AiGatewayModelProfile | undefined => foundationModelProfiles(endpoint).next().value;

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

export async function servingEndpoints(): Promise<ServingEndpoint[]> {
  let client: WorkspaceClient | null = null;
  try {
    client = getExecutionContext().client;
  } catch (error) {
    client = new WorkspaceClient({});
  }
  const data = await httpUtils.fetchApi(client, "/serving-endpoints");
  console.log(data);
  return data?.endpoints ?? [];
}
