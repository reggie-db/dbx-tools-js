/**
 * Wire-format types for the model toolkit: the model class taxonomy,
 * the Foundation Model API score profile, the minimal serving-endpoint
 * descriptor, and the model-lookup request / ranked-result contract.
 * Pure types and zod schemas - no Node-only imports - so a browser
 * client (or an agent tool's `inputSchema`) can validate a lookup
 * request and type a ranked response without dragging in server
 * dependencies.
 */

import { z } from "zod";

/**
 * Class of a Databricks Model Serving endpoint - its modality plus,
 * for chat models, a capability band. Chat endpoints split by measured
 * `quality` into a three-rung ladder; embeddings are a separate
 * modality, not a rung on that ladder.
 *
 * String enum so the value is the slug used in cache keys, logs, query
 * strings, and serialized configs - and is what a client sends to
 * request a class.
 */
export enum ModelClass {
  ChatThinking = "chat-thinking",
  ChatBalanced = "chat-balanced",
  ChatFast = "chat-fast",
  Embedding = "embedding",
}

const ModelClassDescriptions: Record<ModelClass, string> = {
  [ModelClass.ChatThinking]:
    "Most capable reasoning for hard, multi-step tasks; slowest and most expensive.",
  [ModelClass.ChatBalanced]:
    "Good default for most chat and agent work; balances quality, speed, and cost.",
  [ModelClass.ChatFast]:
    "Fastest and cheapest; best for simple tasks like classification, routing, and short summaries.",
  [ModelClass.Embedding]:
    "Produces text embeddings (vectors), not chat replies; not interchangeable with chat models.",
};

export const ModelClassSchema = z.enum(ModelClass).describe(
  `Endpoint class slug: ${(Object.values(ModelClass) as ModelClass[])
    .map((modelClass) => {
      return `'${modelClass}' (${ModelClassDescriptions[modelClass]})`;
    })
    .join(", ")}.`,
);

/**
 * Foundation Model API quality / speed / cost scores Databricks
 * publishes per pay-per-token endpoint (the bars shown in the AI
 * Playground). Surfaced from the serving list under
 * `config.served_entities[].foundation_model.ai_gateway_model_profile`
 * so the class classifier can rank models from live, workspace-local
 * numbers instead of a hand-maintained table. Scales are relative and
 * unitless; all axes are absent for custom or brand-new endpoints that
 * have no profile yet.
 */
export const ModelProfileSchema = z.object({
  quality: z.number().optional().describe("Relative quality score; higher is better."),
  speed: z.number().optional().describe("Relative throughput score; higher is faster."),
  cost: z.number().optional().describe("Relative price score; lower is cheaper."),
});
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

/**
 * Minimal descriptor for a Databricks Model Serving endpoint - a
 * stable subset of the SDK type so cache hits and `/models` responses
 * never expose SDK internals.
 */
export const ServingEndpointSummarySchema = z.object({
  name: z
    .string()
    .describe(
      "Endpoint name as listed by the Model Serving REST API; the id used to invoke the model.",
    ),
  task: z
    .string()
    .optional()
    .describe("Task hint, e.g. 'llm/v1/chat' or 'llm/v1/embeddings'."),
  state: z
    .string()
    .optional()
    .describe("Deployment state, e.g. ready, updating, or failed."),
  description: z
    .string()
    .optional()
    .describe("Free-form endpoint description; informational."),
  profile: ModelProfileSchema.optional().describe(
    "Foundation Model API quality/speed/cost scores when the endpoint is a scored pay-per-token model; absent otherwise.",
  ),
  class: ModelClassSchema.optional().describe(
    "Class the endpoint was classified into; absent when the classifier doesn't recognize it.",
  ),
  dimension: z
    .number()
    .optional()
    .describe(
      "Embedding vector length, measured by a best-effort server-side ping. Only set for embedding endpoints, and only when the probe succeeded.",
    ),
});
export type ServingEndpointSummary = z.infer<typeof ServingEndpointSummarySchema>;

/**
 * A model-lookup request: search string, capability ceiling, both, or
 * nothing. This is the caller-facing query the `@dbx-tools/model`
 * ranker reads - shaped as a zod schema (with per-field descriptions)
 * so an agent tool can adopt it directly as its `inputSchema` and a
 * browser client can validate args before calling the model service.
 *
 * Every field is optional: an empty query ranks the live catalogue by
 * class alone. The "this class and below" ceiling semantics and the
 * match-then-class ordering live in the service, not here - this
 * surface is declarative.
 */
export const ModelQuerySchema = z.object({
  search: z
    .string()
    .optional()
    .describe(
      "Loose name fuzzy-matched against endpoint names, e.g. 'claude sonnet'. Omit to rank by class alone.",
    ),
  modelClass: ModelClassSchema.optional().describe(
    "Capability ceiling: a chat class restricts to that band and the less-capable chat bands below it; 'embedding' restricts to embedding endpoints. Omit to consider every chat band.",
  ),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .optional()
    .describe("Maximum number of ranked results to return."),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      "Fuzzy-match distance cutoff (0 = exact, 1 = match anything). Default 0.4.",
    ),
});
export type ModelQuery = z.infer<typeof ModelQuerySchema>;

/**
 * One ranked lookup result. Backs an agent tool's `outputSchema` and a
 * `/models` ranked response.
 */
export const RankedModelSchema = z.object({
  endpoint: ServingEndpointSummarySchema.describe("The matched serving endpoint."),
  modelClass: ModelClassSchema.describe("Class the endpoint was classified into."),
  score: z
    .number()
    .optional()
    .describe(
      "Fuzzy-match distance (0 = exact .. 1 = worst) when the query carried a search; absent for class-only ranking.",
    ),
});
export type RankedModel = z.infer<typeof RankedModelSchema>;
