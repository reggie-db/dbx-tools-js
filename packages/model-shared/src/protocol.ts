/**
 * Wire-format types for the model toolkit: capability tiers, the
 * Foundation Model API score profile, and the minimal serving-endpoint
 * descriptor. Pure types and zod schemas - no Node-only imports - so a
 * browser client can validate a tier request or type a `/models`
 * response without dragging in server dependencies.
 */

import { z } from "zod";

/**
 * Capability tiers for chat-capable serving endpoints.
 *
 * - {@link ModelTier.Thinking}: highest measured `quality`; deepest
 *   reasoning, highest cost / latency. Reserve for hard multi-step work.
 * - {@link ModelTier.Balanced}: the middle of the quality distribution;
 *   the right default for most agent work.
 * - {@link ModelTier.Fast}: lowest `quality` band, which in practice is
 *   also the cheapest and quickest; classification, routing, tool-arg
 *   extraction, simple summarisation.
 *
 * String enum so the value is the slug used in cache keys, logs, query
 * strings, and serialized configs - and is what a client sends to
 * request a tier.
 */
export enum ModelTier {
  Thinking = "thinking",
  Balanced = "balanced",
  Fast = "fast",
}

/** Schema for a single {@link ModelTier} value (e.g. a client request). */
export const ModelTierSchema = z.nativeEnum(ModelTier);

/**
 * Coerce an arbitrary value (query string, header, body field) to a
 * {@link ModelTier}, returning `null` when it isn't a known tier. Lets
 * a client or server accept a tier request without throwing on junk
 * input.
 */
export function parseModelTier(value: unknown): ModelTier | null {
  const parsed = ModelTierSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * Foundation Model API quality / speed / cost scores Databricks
 * publishes per pay-per-token endpoint (the bars shown in the AI
 * Playground). Surfaced from the serving list under
 * `config.served_entities[].foundation_model.ai_gateway_model_profile`
 * so the tier classifier can rank models from live, workspace-local
 * numbers instead of a hand-maintained table.
 *
 * Scales are relative and unitless: `quality` higher is better,
 * `speed` is throughput (higher is faster), `cost` is relative price
 * (lower is cheaper). All optional - custom and brand-new endpoints
 * have no profile yet.
 */
export const ModelProfileSchema = z.object({
  quality: z.number().optional(),
  speed: z.number().optional(),
  cost: z.number().optional(),
});
export type ModelProfile = z.infer<typeof ModelProfileSchema>;

/**
 * Minimal descriptor for a Databricks Model Serving endpoint - a
 * stable subset of the SDK type so cache hits and `/models` responses
 * never expose SDK internals.
 *
 * Fields:
 *   - `name`: endpoint name as listed by the Model Serving REST API.
 *   - `task`: task hint (e.g. `"llm/v1/chat"`). Useful for filtering.
 *   - `state`: ready / updating / failed state.
 *   - `description`: free-form description; mostly informational.
 *   - `profile`: Foundation Model API quality/speed/cost scores when
 *     the endpoint is a scored pay-per-token model; absent otherwise.
 */
export const ServingEndpointSummarySchema = z.object({
  name: z.string(),
  task: z.string().optional(),
  state: z.string().optional(),
  description: z.string().optional(),
  profile: ModelProfileSchema.optional(),
});
export type ServingEndpointSummary = z.infer<typeof ServingEndpointSummarySchema>;
