import { describe, expect, it } from "bun:test";

import { ModelClass } from "@dbx-tools/model-shared";

import {
  CHAT_CLASS_ORDER,
  classesAtOrBelow,
  isChatClass,
  MODEL_CLASS_ORDER,
  parseModelClass,
} from "../src/classes.js";

describe("CHAT_CLASS_ORDER / MODEL_CLASS_ORDER", () => {
  it("orders chat bands most-capable first, embedding excluded from the ladder", () => {
    expect(CHAT_CLASS_ORDER).toEqual([
      ModelClass.ChatThinking,
      ModelClass.ChatBalanced,
      ModelClass.ChatFast,
    ]);
    expect(MODEL_CLASS_ORDER).toEqual([
      ModelClass.ChatThinking,
      ModelClass.ChatBalanced,
      ModelClass.ChatFast,
      ModelClass.Embedding,
    ]);
  });
});

describe("isChatClass", () => {
  it("is true for chat bands and false for embedding", () => {
    expect(isChatClass(ModelClass.ChatThinking)).toBe(true);
    expect(isChatClass(ModelClass.ChatFast)).toBe(true);
    expect(isChatClass(ModelClass.Embedding)).toBe(false);
  });
});

describe("classesAtOrBelow", () => {
  it("treats a chat band as a ceiling - the band and everything below it", () => {
    expect(classesAtOrBelow(ModelClass.ChatThinking)).toEqual([
      ModelClass.ChatThinking,
      ModelClass.ChatBalanced,
      ModelClass.ChatFast,
    ]);
    expect(classesAtOrBelow(ModelClass.ChatBalanced)).toEqual([
      ModelClass.ChatBalanced,
      ModelClass.ChatFast,
    ]);
    expect(classesAtOrBelow(ModelClass.ChatFast)).toEqual([ModelClass.ChatFast]);
  });

  it("keeps embedding to itself - it is not a rung on the chat ladder", () => {
    expect(classesAtOrBelow(ModelClass.Embedding)).toEqual([ModelClass.Embedding]);
  });
});

describe("parseModelClass", () => {
  it("accepts full slugs and rejects junk", () => {
    expect(parseModelClass("chat-thinking")).toBe(ModelClass.ChatThinking);
    expect(parseModelClass("chat-balanced")).toBe(ModelClass.ChatBalanced);
    expect(parseModelClass("chat-fast")).toBe(ModelClass.ChatFast);
    expect(parseModelClass("embedding")).toBe(ModelClass.Embedding);
    expect(parseModelClass("medium")).toBeNull();
    expect(parseModelClass(undefined)).toBeNull();
  });

  it("resolves a bare chat band via the chat- prefix shorthand", () => {
    expect(parseModelClass("thinking")).toBe(ModelClass.ChatThinking);
    expect(parseModelClass("balanced")).toBe(ModelClass.ChatBalanced);
    expect(parseModelClass("fast")).toBe(ModelClass.ChatFast);
  });
});
