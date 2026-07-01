import { afterEach, describe, expect, it } from "bun:test";

import type { appkitUtils } from "@dbx-tools/shared";
import type { ProcessInputArgs } from "@mastra/core/processors";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";

import { MASTRA_USER_KEY } from "../src/config.js";
import type { ManagedMemoryRuntime } from "../src/connectors/managed-memory/types.js";
import { buildManagedMemoryRecallProcessor } from "../src/processors/managed-memory-recall.js";

const HOST = "https://example.cloud.databricks.com";

const RUNTIME: ManagedMemoryRuntime = {
  storeName: "main.default.mem",
  topK: 3,
  entryPath: "/memories/notes.md",
  tools: true,
  recall: true,
};

/** Fake OBO client carried on the request-context user. */
function fakeExecutionContext(): appkitUtils.ExecutionContextLike {
  return {
    client: {
      config: {
        getHost: async () => HOST,
        authenticate: async (headers: Headers) => {
          headers.set("Authorization", "Bearer t");
        },
      },
    },
  } as unknown as appkitUtils.ExecutionContextLike;
}

/** Minimal request context stamped like `MastraServer` does. */
function requestContext(opts: { scope?: string; userId?: string }): {
  get: (key: string) => unknown;
} {
  const map: Record<string, unknown> = {
    [MASTRA_USER_KEY]: {
      id: opts.userId ?? "user@x.com",
      executionContext: fakeExecutionContext(),
    },
    ...(opts.scope ? { [MASTRA_RESOURCE_ID_KEY]: opts.scope } : {}),
  };
  return { get: (key: string) => map[key] };
}

/** Build a `ProcessInputArgs` with a single user-text message. */
function inputArgs(
  text: string | null,
  ctx: ReturnType<typeof requestContext> | undefined,
): ProcessInputArgs {
  const messages =
    text === null
      ? []
      : [{ role: "user", content: { parts: [{ type: "text", text }] } }];
  return {
    messages,
    systemMessages: [],
    requestContext: ctx,
  } as unknown as ProcessInputArgs;
}

/** Stub fetch to return a fixed search payload; returns a restore fn. */
function stubSearch(body: unknown): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
    })) as unknown as typeof globalThis.fetch;
  return () => void (globalThis.fetch = original);
}

afterEach(() => {
  // Each test restores its own stub; nothing global to reset here.
});

describe("managed-memory-recall processor", () => {
  it("injects recalled entries as a system message", async () => {
    const restore = stubSearch({
      entries: [
        { contents: "prefers EUR", description: "currency" },
        { contents: "always show SQL" },
      ],
    });
    try {
      const processor = buildManagedMemoryRecallProcessor(RUNTIME);
      const result = await processor.processInput!(
        inputArgs("what is my revenue?", requestContext({ scope: "user@x.com" })),
      );
      expect(Array.isArray(result)).toBe(false);
      const out = result as {
        systemMessages: Array<{ role: string; content: string }>;
      };
      expect(out.systemMessages).toHaveLength(1);
      expect(out.systemMessages[0]!.role).toBe("system");
      expect(out.systemMessages[0]!.content).toContain("currency: prefers EUR");
      expect(out.systemMessages[0]!.content).toContain("- always show SQL");
    } finally {
      restore();
    }
  });

  it("passes messages through unchanged when there is no user text", async () => {
    const restore = stubSearch({ entries: [{ contents: "x" }] });
    try {
      const processor = buildManagedMemoryRecallProcessor(RUNTIME);
      const args = inputArgs(null, requestContext({ scope: "u" }));
      const result = await processor.processInput!(args);
      expect(result).toBe(args.messages);
    } finally {
      restore();
    }
  });

  it("passes through when no scope / user is resolvable", async () => {
    const restore = stubSearch({ entries: [{ contents: "x" }] });
    try {
      const processor = buildManagedMemoryRecallProcessor(RUNTIME);
      const args = inputArgs("hi", undefined);
      const result = await processor.processInput!(args);
      expect(result).toBe(args.messages);
    } finally {
      restore();
    }
  });

  it("passes through when search returns no entries", async () => {
    const restore = stubSearch({ entries: [] });
    try {
      const processor = buildManagedMemoryRecallProcessor(RUNTIME);
      const args = inputArgs("hi", requestContext({ scope: "u" }));
      const result = await processor.processInput!(args);
      expect(result).toBe(args.messages);
    } finally {
      restore();
    }
  });

  it("degrades to pass-through on a search error", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("boom");
    }) as unknown as typeof globalThis.fetch;
    try {
      const processor = buildManagedMemoryRecallProcessor(RUNTIME);
      const args = inputArgs("hi", requestContext({ scope: "u" }));
      const result = await processor.processInput!(args);
      expect(result).toBe(args.messages);
    } finally {
      globalThis.fetch = original;
    }
  });
});
