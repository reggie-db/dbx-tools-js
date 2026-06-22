import { describe, expect, it } from "bun:test";

import { classifyByFamily, classifyEndpoints, versionTuple } from "../src/classify.js";
import {
  ModelClass,
  type ModelProfile,
  type ServingEndpointSummary,
} from "../src/protocol.js";

const CHAT_TASK = "llm/v1/chat";
const EMBEDDING_TASK = "llm/v1/embeddings";

/** Build a chat serving endpoint, optionally scored, for classifier fixtures. */
function chat(name: string, profile?: ModelProfile): ServingEndpointSummary {
  return { name, task: CHAT_TASK, ...(profile ? { profile } : {}) };
}

/** Build an embedding serving endpoint for classifier fixtures. */
function embedding(name: string): ServingEndpointSummary {
  return { name, task: EMBEDDING_TASK };
}

/** Names of the endpoints classified into `cls`, in ranked order. */
function classNames(
  buckets: Record<ModelClass, ServingEndpointSummary[]>,
  cls: ModelClass,
): string[] {
  return buckets[cls].map((e) => e.name);
}

describe("versionTuple", () => {
  it("reads major.minor.patch starting at the first digit", () => {
    expect(versionTuple("databricks-claude-opus-4-8")).toEqual([4, 8, 0]);
    expect(versionTuple("databricks-claude-opus-4-7")).toEqual([4, 7, 0]);
    expect(versionTuple("databricks-gpt-5-5")).toEqual([5, 5, 0]);
  });

  it("keeps double-digit components numeric (no decimal collapse)", () => {
    expect(versionTuple("databricks-claude-opus-4-10")).toEqual([4, 10, 0]);
    // 4.10 must sort ABOVE 4.8 - the bug a `major + minor/10` score hit.
    const [, tenMinor] = versionTuple("databricks-claude-opus-4-10");
    const [, eightMinor] = versionTuple("databricks-claude-opus-4-8");
    expect(tenMinor).toBeGreaterThan(eightMinor);
  });

  it("reads a parameter-size suffix as the patch component", () => {
    expect(versionTuple("databricks-meta-llama-3-3-70b-instruct")).toEqual([3, 3, 70]);
    expect(versionTuple("databricks-gpt-oss-120b")).toEqual([120, 0, 0]);
  });

  it("returns all-zero for names with no digits", () => {
    expect(versionTuple("databricks-bge-large-en")).toEqual([0, 0, 0]);
  });
});

describe("classifyEndpoints", () => {
  it("buckets scored models by quality quantiles, best-first", () => {
    // Three clear quality bands (gaps keep the 1/3 and 2/3 quantiles
    // between bands), two models per chat band.
    const buckets = classifyEndpoints([
      chat("databricks-claude-opus-4-8", { quality: 90, cost: 10, speed: 44 }),
      chat("databricks-claude-opus-4-7", { quality: 88, cost: 10, speed: 44 }),
      chat("databricks-claude-sonnet-4-6", { quality: 50, cost: 18, speed: 55 }),
      chat("databricks-gpt-5-5", { quality: 48, cost: 20, speed: 50 }),
      chat("databricks-claude-haiku-4-5", { quality: 10, cost: 5, speed: 80 }),
      chat("databricks-meta-llama-3-1-8b-instruct", { quality: 8, cost: 3, speed: 90 }),
    ]);
    expect(classNames(buckets, ModelClass.ChatThinking)).toEqual([
      "databricks-claude-opus-4-8",
      "databricks-claude-opus-4-7",
    ]);
    expect(classNames(buckets, ModelClass.ChatBalanced)).toEqual([
      "databricks-claude-sonnet-4-6",
      "databricks-gpt-5-5",
    ]);
    expect(classNames(buckets, ModelClass.ChatFast)).toEqual([
      "databricks-claude-haiku-4-5",
      "databricks-meta-llama-3-1-8b-instruct",
    ]);
  });

  it("breaks a scored tie (same quality/cost/speed) by parsed version", () => {
    // All identical except the trailing version: only versionTuple can
    // order them. This is the live `q=46` Opus case.
    const buckets = classifyEndpoints([
      chat("databricks-claude-opus-4-6", { quality: 90, cost: 10, speed: 44 }),
      chat("databricks-claude-opus-4-8", { quality: 90, cost: 10, speed: 44 }),
      chat("databricks-claude-opus-4-7", { quality: 90, cost: 10, speed: 44 }),
    ]);
    expect(classNames(buckets, ModelClass.ChatThinking)).toEqual([
      "databricks-claude-opus-4-8",
      "databricks-claude-opus-4-7",
      "databricks-claude-opus-4-6",
    ]);
  });

  it("orders a double-digit point release above a single-digit one", () => {
    const buckets = classifyEndpoints([
      chat("databricks-claude-opus-4-9", { quality: 90, cost: 10, speed: 44 }),
      chat("databricks-claude-opus-4-10", { quality: 90, cost: 10, speed: 44 }),
    ]);
    expect(classNames(buckets, ModelClass.ChatThinking)).toEqual([
      "databricks-claude-opus-4-10",
      "databricks-claude-opus-4-9",
    ]);
  });

  it("places unscored but recognizable chat endpoints by family heuristic", () => {
    const buckets = classifyEndpoints([
      chat("databricks-claude-opus-4-1"),
      chat("databricks-claude-sonnet-4-0"),
      chat("databricks-claude-haiku-3-5"),
    ]);
    expect(classNames(buckets, ModelClass.ChatThinking)).toEqual([
      "databricks-claude-opus-4-1",
    ]);
    expect(classNames(buckets, ModelClass.ChatBalanced)).toEqual([
      "databricks-claude-sonnet-4-0",
    ]);
    expect(classNames(buckets, ModelClass.ChatFast)).toEqual([
      "databricks-claude-haiku-3-5",
    ]);
  });

  it("buckets embedding endpoints by task, regardless of name or score", () => {
    const buckets = classifyEndpoints([
      chat("databricks-claude-opus-4-1"),
      embedding("databricks-gte-large-en"),
      embedding("databricks-bge-large-en"),
    ]);
    expect(classNames(buckets, ModelClass.Embedding)).toEqual([
      "databricks-gte-large-en",
      "databricks-bge-large-en",
    ]);
    // Embeddings never leak into a chat band.
    expect(classNames(buckets, ModelClass.ChatThinking)).toEqual([
      "databricks-claude-opus-4-1",
    ]);
  });

  it("omits unrecognized unscored chat endpoints from every chat band", () => {
    const buckets = classifyEndpoints([
      chat("databricks-claude-opus-4-1"),
      chat("databricks-some-custom-thing"),
    ]);
    const chatNames = [
      ...buckets[ModelClass.ChatThinking],
      ...buckets[ModelClass.ChatBalanced],
      ...buckets[ModelClass.ChatFast],
    ].map((e) => e.name);
    expect(chatNames).toEqual(["databricks-claude-opus-4-1"]);
  });
});

describe("classifyByFamily", () => {
  it("maps well-known variants to chat classes and returns null for unknowns", () => {
    expect(classifyByFamily("databricks-claude-opus-4-8")?.class).toBe(
      ModelClass.ChatThinking,
    );
    expect(classifyByFamily("databricks-claude-sonnet-4-6")?.class).toBe(
      ModelClass.ChatBalanced,
    );
    expect(classifyByFamily("databricks-claude-haiku-4-5")?.class).toBe(
      ModelClass.ChatFast,
    );
    expect(classifyByFamily("databricks-gpt-5-nano")?.class).toBe(ModelClass.ChatFast);
    expect(classifyByFamily("databricks-some-custom-thing")).toBeNull();
  });
});
