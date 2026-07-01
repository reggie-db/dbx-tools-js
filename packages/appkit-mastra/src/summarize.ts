/**
 * Small-tier summarization for the Mastra plugin.
 *
 * Two surfaces, both backed by the fast / small chat tier
 * ({@link ModelClass.ChatFast}) resolved through the same
 * `/serving-endpoints` pipeline as the main agents:
 *
 *   - A dedicated `summarize` tool (see {@link buildSummarizeTool})
 *     agents can call to condense arbitrary text without burning the
 *     heavyweight chat model.
 *   - The model + instructions Mastra's memory uses to auto-name
 *     conversation threads (`generateTitle`), so titling reuses the
 *     same small tier rather than the agent's primary model.
 *
 * Mirrors the chart-planner wiring in `chart.ts`: a per-config cached
 * `Agent` on the fast tier, invoked via `agent.generate(...)` inside
 * the active `asUser` scope so tokens stay user-scoped.
 */

import { ModelClass } from "@dbx-tools/model";
import { stringUtils } from "@dbx-tools/shared";
import { Agent } from "@mastra/core/agent";
import type { MastraModelConfig } from "@mastra/core/llm";
import type { RequestContext } from "@mastra/core/request-context";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";

import type { MastraPluginConfig } from "./config.js";
import { buildModel } from "./model.js";

/** Fast / small chat tier used for both titling and summaries. */
const SUMMARY_MODEL_CLASS = ModelClass.ChatFast;

/** System prompt for the summarizer agent (and the `summarize` tool). */
const SUMMARIZER_INSTRUCTIONS = [
  "You are a summarization engine.",
  "Given a block of text, produce a faithful, concise summary of it.",
  "Default to a few sentences; follow any length guidance the caller gives.",
  "Plain prose. No preamble, no headers, no bullet points unless asked.",
  "Never use emojis. Use hyphens (-) only, never em dashes or en dashes.",
  "Never add information, opinions, or details not present in the input.",
  "Output only the summary.",
].join("\n");

/**
 * Instructions Mastra's `generateTitle` hands the small-tier model to
 * name a conversation thread from its opening turn. Kept terse so the
 * model returns a bare title with no decoration.
 */
export const TITLE_INSTRUCTIONS = [
  "Generate a short, specific title for this conversation, 3 to 6 words.",
  "Capture the user's topic, not the assistant's response.",
  "Plain text only: no surrounding quotes, no trailing punctuation,",
  "no emojis, and no em dashes. Output only the title.",
].join(" ");

/**
 * Resolve the small-tier model for summarization / titling. Reused by
 * both the summarizer agent and Mastra memory's `generateTitle`.
 *
 * Returned as a `requestContext`-taking function (a Mastra
 * `DynamicArgument<MastraModelConfig>`) so each call mints user-scoped
 * tokens via {@link buildModel}, exactly like the primary agents.
 */
export function summaryModel(
  config: MastraPluginConfig,
): (args: { requestContext: RequestContext }) => Promise<MastraModelConfig> {
  return ({ requestContext }) =>
    buildModel(config, requestContext, { modelClass: SUMMARY_MODEL_CLASS });
}

/**
 * One summarizer `Agent` per plugin config, cached on config-object
 * identity so a hot tool path doesn't pay the constructor cost each
 * call. `WeakMap` lets retired configs (e.g. test reconfigurations)
 * release their agent without manual eviction.
 */
const summarizerAgents = new WeakMap<MastraPluginConfig, Agent>();

function getSummarizerAgent(config: MastraPluginConfig): Agent {
  let agent = summarizerAgents.get(config);
  if (!agent) {
    agent = new Agent({
      id: "summarizer",
      name: "Summarizer",
      description: "Condenses text into a short summary using a fast, small model.",
      instructions: SUMMARIZER_INSTRUCTIONS,
      model: summaryModel(config),
    });
    summarizerAgents.set(config, agent);
  }
  return agent;
}

/** Inputs accepted by the `summarize` tool. */
const summarizeInput = z.object({
  text: z.string().min(1).describe("The text to summarize."),
  instructions: z
    .string()
    .optional()
    .describe(
      "Optional extra guidance for the summary, e.g. 'one sentence' or 'list the action items'.",
    ),
  maxWords: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Optional soft cap on the summary length, in words."),
});

/** Options accepted by {@link summarizeText}. */
export interface SummarizeOptions {
  /** Extra guidance for the summary (length, focus, format). */
  instructions?: string;
  /** Soft cap on summary length, in words. */
  maxWords?: number;
  /** Active request context, so the model resolver mints user-scoped tokens. */
  requestContext?: RequestContext;
  /** Abort signal bridged from the calling tool / request. */
  abortSignal?: AbortSignal;
}

/**
 * Summarize `text` with the small-tier summarizer agent, returning the
 * trimmed summary string. Throws on model failure (the caller decides
 * how to degrade).
 */
export async function summarizeText(
  config: MastraPluginConfig,
  text: string,
  options: SummarizeOptions = {},
): Promise<string> {
  const { instructions, maxWords, requestContext, abortSignal } = options;
  const prompt = stringUtils.toDescription({
    ...(instructions ? { Guidance: instructions } : {}),
    ...(maxWords !== undefined ? { "Max length (words)": String(maxWords) } : {}),
    Text: text,
  });
  const result = await getSummarizerAgent(config).generate(prompt, {
    ...(requestContext ? { requestContext } : {}),
    ...(abortSignal ? { abortSignal } : {}),
  });
  return result.text.trim();
}

/**
 * Build the `summarize` tool. Exposed as an ambient system tool (like
 * `render_data`) so every agent can offload condensing long content,
 * notes, transcripts, or bulky tool results to the fast tier instead of
 * spending its primary chat model. The tool reads the live
 * `requestContext` / `abortSignal` off the Mastra execution context so
 * its model call stays user-scoped and cancels with the turn.
 */
export function buildSummarizeTool(config: MastraPluginConfig) {
  return createTool({
    id: "summarize",
    description:
      "Summarize a block of text using a fast, small model. Use it to condense long " +
      "content, notes, transcripts, or tool results into a short summary without " +
      "spending the main chat model.",
    inputSchema: summarizeInput,
    execute: async (input, context) => {
      const { text, instructions, maxWords } = input as z.infer<typeof summarizeInput>;
      const ctx = context as
        | { requestContext?: RequestContext; abortSignal?: AbortSignal }
        | undefined;
      const summary = await summarizeText(config, text, {
        ...(instructions ? { instructions } : {}),
        ...(maxWords !== undefined ? { maxWords } : {}),
        ...(ctx?.requestContext ? { requestContext: ctx.requestContext } : {}),
        ...(ctx?.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
      });
      return { summary };
    },
  });
}
