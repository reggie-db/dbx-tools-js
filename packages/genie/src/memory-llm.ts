import {
  LLMFactory,
  OpenAILLM,
  type LLM,
  type LLMConfig,
  type LLMResponse,
  type Message,
} from "mem0ai/oss";

// Minimal structural shape of the OpenAI client's chat-completions
// surface. We type the inner client this way instead of `import OpenAI
// from "openai"` to avoid taking a direct dep on the `openai` package;
// mem0 pulls it in transitively and we just need to invoke one method.
interface OpenAIChatLike {
  chat: {
    completions: {
      create(req: {
        model: string;
        messages: Array<{
          role: "system" | "user" | "assistant" | "tool";
          content: string;
        }>;
      }): Promise<{
        choices: Array<{ message?: { content?: string | null } }>;
      }>;
    };
  };
}

// Databricks Foundation Model API-aware mem0 LLM. Wraps mem0's `OpenAILLM`
// and strips the `response_format` argument before forwarding to the
// underlying OpenAI client.
//
// Why: Databricks-hosted models on `/serving-endpoints/chat/completions`
// enforce an OpenAI-derived guardrail: when `response_format` is
// `{type: "json_object"}`, *some* user/assistant message must literally
// contain the substring "json" (case-insensitive). mem0's
// `addToVectorStore` always passes `{type: "json_object"}` but its
// user-prompt builder (`generateAdditiveExtractionPrompt`) only emits
// structural headings ("## Summary", "## New Messages", etc.) and never
// includes the word "json" - so every memory-extraction call fails with
// `Bad request: "messages" must contain the word "json"`.
//
// The system prompt already explicitly says "Return ONLY valid JSON
// parsable by json.loads()", and Llama-3.3 / GPT-OSS variants reliably
// produce JSON even without `response_format`. mem0's `extractJson()`
// post-processor is forgiving (strips ```json fences, finds the first
// balanced `{...}` block) so dropping `response_format` is safe.

// Internal view of mem0's OpenAILLM's private fields. mem0 declares them
// `private` in d.ts but they're regular own-properties at runtime.
interface _OpenAILLMInternals {
  openai: OpenAIChatLike;
  model: string;
}

/**
 * Marker config key. Set on the mem0 llm config:
 * `{ provider: "openai", config: { databricksFmApi: true, ... } }`.
 * The factory patch installed by {@link installDatabricksLlmPatch}
 * checks for this key before substituting our subclass; configs
 * without it fall through to the original `LLMFactory.create` (so
 * non-Databricks mem0 deployments in the same process keep working).
 */
export const DATABRICKS_FM_API_KEY = "databricksFmApi" as const;

/** Shape of the mem0 openai config that opts into the Databricks path. */
export interface DatabricksFmApiLLMConfig extends LLMConfig {
  /** Set to `true` to route through {@link DatabricksFmApiLLM}. */
  [DATABRICKS_FM_API_KEY]?: boolean;
}

/**
 * mem0 LLM wrapper that omits the `response_format` argument when
 * forwarding to the OpenAI client. Inherits everything else from mem0's
 * `OpenAILLM` (`generateChat`, the tool-call branch of
 * `generateResponse`, etc.) by direct delegation.
 *
 * Construction-time caveat: we don't `extends OpenAILLM` because mem0's
 * `OpenAILLM` constructor immediately builds an OpenAI client and we'd
 * have no opportunity to mutate behavior in the subclass body before the
 * parent's methods bind. Composition lets us forward selectively while
 * still satisfying the structural `LLM` interface mem0 expects.
 */
export class DatabricksFmApiLLM implements LLM {
  private readonly inner: OpenAILLM;
  private readonly openai: OpenAIChatLike;
  private readonly model: string;

  constructor(config: LLMConfig) {
    this.inner = new OpenAILLM(config);
    // mem0's OpenAILLM stashes the constructed OpenAI client on
    // `this.openai` and the model name on `this.model`. We reuse both so
    // we don't construct a second OpenAI client (one less file
    // descriptor + one less TLS session for the underlying agent).
    const internals = this.inner as unknown as _OpenAILLMInternals;
    this.openai = internals.openai;
    this.model = internals.model;
  }

  /**
   * Drop `responseFormat` before delegating. Everything else mirrors
   * mem0's `OpenAILLM.generateResponse` exactly so a future mem0 release
   * that adds e.g. seed/temperature handling flows through unchanged
   * (because tools / response branches go through `inner`).
   */
  async generateResponse(
    messages: Message[],
    _responseFormat?: { type: string },
    tools?: Parameters<OpenAILLM["generateResponse"]>[2],
  ): ReturnType<OpenAILLM["generateResponse"]> {
    // When tools are present mem0 wants the tool-calling branch; the
    // `response_format` argument isn't passed in that path anyway, so
    // delegating to the inner instance is correct.
    if (tools) {
      return this.inner.generateResponse(messages, undefined, tools);
    }
    const completion = await this.openai.chat.completions.create({
      messages: messages.map((msg) => ({
        role: msg.role as "system" | "user" | "assistant",
        content:
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content),
      })),
      model: this.model,
    });
    const response = completion.choices[0]?.message;
    return response?.content ?? "";
  }

  // The remaining mem0 LLM surface (`generateChat`, plus anything added
  // in future minor releases) goes through the underlying OpenAILLM
  // verbatim. They don't pass `response_format` so the Databricks
  // guardrail doesn't apply.
  async generateChat(messages: Message[]): Promise<LLMResponse> {
    return this.inner.generateChat(messages);
  }
}

// Module-level latch so the factory monkey-patch is idempotent across
// plugin restarts (hot reload, multiple installs from tests).
let _patched = false;

/**
 * Monkey-patch `LLMFactory.create` to substitute
 * {@link DatabricksFmApiLLM} for the bundled `OpenAILLM` whenever the
 * provided config carries a {@link DATABRICKS_FM_API_KEY} field set
 * truthy. Configs without the marker fall through to the original
 * factory unchanged, so non-Databricks mem0 deployments in the same
 * process keep working.
 *
 * Safe to call multiple times - subsequent invocations are no-ops.
 */
export function installDatabricksLlmPatch(): void {
  if (_patched) return;
  _patched = true;

  type FactoryCreate = (provider: string, config: LLMConfig) => LLM;
  const factory = LLMFactory as unknown as { create: FactoryCreate };
  const originalCreate = factory.create.bind(LLMFactory);

  factory.create = (provider: string, config: LLMConfig): LLM => {
    if (
      provider.toLowerCase() === "openai" &&
      (config as Partial<DatabricksFmApiLLMConfig>)[DATABRICKS_FM_API_KEY]
    ) {
      return new DatabricksFmApiLLM(config);
    }
    return originalCreate(provider, config);
  };
}
