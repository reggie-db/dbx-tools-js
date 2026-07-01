import { afterEach, describe, expect, it } from "bun:test";

import type { appkitUtils } from "@dbx-tools/shared";

import {
  ensureStore,
  getStore,
  parseStoreName,
  search,
  writeEntry,
} from "../src/connectors/managed-memory/client.js";
import { resolveManagedMemoryTarget } from "../src/connectors/managed-memory/resolve.js";

const HOST = "https://example.cloud.databricks.com";

/** A fake OBO workspace client exposing only what the client touches. */
function fakeClient(): appkitUtils.WorkspaceClientLike {
  return {
    config: {
      getHost: async () => HOST,
      authenticate: async (headers: Headers) => {
        headers.set("Authorization", "Bearer test-token");
      },
    },
  } as unknown as appkitUtils.WorkspaceClientLike;
}

/** Captured outgoing request for assertions. */
interface Captured {
  url: string;
  method: string;
  body: unknown;
  auth: string | null;
}

/**
 * Install a fetch stub that records each request and replies from
 * `responder`. Returns the capture log and a restore function.
 */
function stubFetch(responder: (req: Captured) => { status?: number; body?: unknown }): {
  calls: Captured[];
  restore: () => void;
} {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const captured: Captured = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      auth: headers.get("Authorization"),
    };
    calls.push(captured);
    const { status = 200, body = {} } = responder(captured);
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

afterEach(() => {
  delete process.env["MEMORY_STORE"];
});

describe("parseStoreName", () => {
  it("splits a three-level name", () => {
    expect(parseStoreName("main.default.mem")).toEqual({
      catalog: "main",
      schema: "default",
      name: "mem",
    });
  });

  it("throws on a non-three-level name", () => {
    expect(() => parseStoreName("main.default")).toThrow(/three-level/);
    expect(() => parseStoreName("main..mem")).toThrow(/three-level/);
  });
});

describe("getStore", () => {
  it("returns the payload on 200", async () => {
    const { calls, restore } = stubFetch(() => ({ body: { name: "mem" } }));
    try {
      const store = await getStore(fakeClient(), "main.default.mem");
      expect(store).toEqual({ name: "mem" });
      expect(calls[0]!.method).toBe("GET");
      expect(calls[0]!.url).toBe(
        `${HOST}/api/2.1/unity-catalog/memory-stores/main.default.mem`,
      );
      expect(calls[0]!.auth).toBe("Bearer test-token");
    } finally {
      restore();
    }
  });

  it("returns null on 404", async () => {
    const { restore } = stubFetch(() => ({ status: 404 }));
    try {
      expect(await getStore(fakeClient(), "main.default.mem")).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("ensureStore", () => {
  it("creates the store when missing", async () => {
    const { calls, restore } = stubFetch((req) =>
      req.method === "GET" ? { status: 404 } : { body: {} },
    );
    try {
      const ok = await ensureStore(fakeClient(), "main.default.mem", "desc");
      expect(ok).toBe(true);
      const post = calls.find((c) => c.method === "POST");
      expect(post!.url).toBe(`${HOST}/api/2.1/unity-catalog/memory-stores`);
      expect(post!.body).toEqual({
        name: "mem",
        catalog_name: "main",
        schema_name: "default",
        description: "desc",
      });
    } finally {
      restore();
    }
  });

  it("does not create when the store already exists", async () => {
    const { calls, restore } = stubFetch(() => ({ body: { name: "mem" } }));
    try {
      await ensureStore(fakeClient(), "main.default.mem", "desc");
      expect(calls.every((c) => c.method === "GET")).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("writeEntry", () => {
  it("posts to the entries endpoint with the scope query and body", async () => {
    const { calls, restore } = stubFetch(() => ({ body: {} }));
    try {
      await writeEntry(fakeClient(), "main.default.mem", "user@x.com", {
        path: "/memories/notes.md",
        contents: "prefers EUR",
        description: "currency",
      });
      expect(calls[0]!.method).toBe("POST");
      expect(calls[0]!.url).toBe(
        `${HOST}/api/2.1/unity-catalog/memory-stores/main.default.mem/entries?scope=user%40x.com`,
      );
      expect(calls[0]!.body).toEqual({
        path: "/memories/notes.md",
        contents: "prefers EUR",
        description: "currency",
      });
    } finally {
      restore();
    }
  });
});

describe("search", () => {
  it("parses the entries envelope and caps to topK", async () => {
    const { calls, restore } = stubFetch(() => ({
      body: {
        entries: [
          { contents: "a", description: "first", score: 0.9 },
          { content: "b" },
          { text: "c" },
          { contents: "d" },
        ],
      },
    }));
    try {
      const results = await search(fakeClient(), "main.default.mem", "u", "q", 3);
      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ contents: "a", description: "first", score: 0.9 });
      expect(results[1]).toEqual({ contents: "b" });
      expect(results[2]).toEqual({ contents: "c" });
      expect(calls[0]!.url).toBe(
        `${HOST}/api/2.1/unity-catalog/memory-stores/main.default.mem/entries:search?scope=u`,
      );
      expect(calls[0]!.body).toEqual({ query: "q", top_k: 3 });
    } finally {
      restore();
    }
  });

  it("drops entries without textual content", async () => {
    const { restore } = stubFetch(() => ({ body: { entries: [{ score: 1 }, {}] } }));
    try {
      expect(await search(fakeClient(), "main.default.mem", "u", "q", 5)).toEqual([]);
    } finally {
      restore();
    }
  });
});

describe("resolveManagedMemoryTarget", () => {
  it("returns null when disabled", () => {
    expect(resolveManagedMemoryTarget({ managedMemory: false })).toBeNull();
  });

  it("returns null in prefer-if-available mode with no env store", () => {
    expect(resolveManagedMemoryTarget({})).toBeNull();
  });

  it("uses MEMORY_STORE in prefer-if-available mode", () => {
    process.env["MEMORY_STORE"] = "main.default.mem";
    const target = resolveManagedMemoryTarget({});
    expect(target?.storeName).toBe("main.default.mem");
    expect(target?.topK).toBe(3);
    expect(target?.autoCreate).toBe(true);
    expect(target?.recall).toBe(true);
    expect(target?.tools).toBe(true);
  });

  it("throws when explicitly enabled with no store", () => {
    expect(() => resolveManagedMemoryTarget({ managedMemory: true })).toThrow(
      /no store name/,
    );
  });

  it("honors an explicit config object", () => {
    const target = resolveManagedMemoryTarget({
      managedMemory: {
        store: "cat.sch.s",
        topK: 7,
        autoCreate: false,
        recall: false,
        tools: false,
      },
    });
    expect(target).toMatchObject({
      storeName: "cat.sch.s",
      topK: 7,
      autoCreate: false,
      recall: false,
      tools: false,
    });
  });
});
