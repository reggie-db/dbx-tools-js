import { describe, expect, it } from "bun:test";

import type { Agent } from "@mastra/core/agent";
import type { StorageThreadType } from "@mastra/core/memory";

import { deleteThread, listThreads, renameThread } from "../src/threads.js";

const RESOURCE = "user-1";

/** A minimal in-memory `Memory` exposing only what the route touches. */
function fakeMemory(opts: {
  threads?: StorageThreadType[];
  total?: number;
  hasMore?: boolean;
  onDelete?: (threadId: string) => void;
  onUpdate?: (args: { id: string; title: string; metadata: unknown }) => void;
}) {
  const threads = opts.threads ?? [];
  return {
    listThreads: async (args: {
      filter?: { resourceId?: string };
      page?: number;
      perPage?: number;
    }) => {
      // Echo the resource filter so the test can assert scoping.
      const owned = threads.filter(
        (t) => !args.filter?.resourceId || t.resourceId === args.filter.resourceId,
      );
      return {
        threads: owned,
        total: opts.total ?? owned.length,
        page: args.page ?? 0,
        perPage: args.perPage ?? 30,
        hasMore: opts.hasMore ?? false,
      };
    },
    getThreadById: async ({ threadId }: { threadId: string }) =>
      threads.find((t) => t.id === threadId) ?? null,
    deleteThread: async (threadId: string) => {
      opts.onDelete?.(threadId);
    },
    updateThread: async (args: {
      id: string;
      title: string;
      metadata: Record<string, unknown>;
    }) => {
      opts.onUpdate?.(args);
      const existing = threads.find((t) => t.id === args.id);
      return {
        ...(existing ?? thread({ id: args.id })),
        title: args.title,
        metadata: args.metadata,
        updatedAt: new Date("2026-01-03T00:00:00.000Z"),
      } satisfies StorageThreadType;
    },
  };
}

/** Wrap a fake memory (or `null`) as an `Agent` for the route helpers. */
function fakeAgent(memory: ReturnType<typeof fakeMemory> | null): Agent {
  return {
    id: "default",
    getMemory: async () => memory,
  } as unknown as Agent;
}

function thread(over: Partial<StorageThreadType> = {}): StorageThreadType {
  return {
    id: "t1",
    title: "First chat",
    resourceId: RESOURCE,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...over,
  };
}

describe("listThreads", () => {
  it("returns an empty page for a stateless agent", async () => {
    const res = await listThreads({ agent: fakeAgent(null), resourceId: RESOURCE });
    expect(res).toEqual({
      threads: [],
      page: 0,
      perPage: 30,
      total: 0,
      hasMore: false,
    });
  });

  it("maps storage threads to the JSON-safe wire shape (ISO dates)", async () => {
    const memory = fakeMemory({ threads: [thread()], total: 1, hasMore: true });
    const res = await listThreads({
      agent: fakeAgent(memory),
      resourceId: RESOURCE,
      perPage: 10,
    });
    expect(res.total).toBe(1);
    expect(res.hasMore).toBe(true);
    expect(res.threads[0]).toEqual({
      id: "t1",
      title: "First chat",
      resourceId: RESOURCE,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
  });

  it("omits an absent title rather than emitting undefined", async () => {
    const memory = fakeMemory({ threads: [thread({ title: undefined })] });
    const res = await listThreads({ agent: fakeAgent(memory), resourceId: RESOURCE });
    expect("title" in res.threads[0]!).toBe(false);
  });

  it("only returns threads owned by the requesting resource", async () => {
    const memory = fakeMemory({
      threads: [thread({ id: "mine" }), thread({ id: "theirs", resourceId: "other" })],
    });
    const res = await listThreads({ agent: fakeAgent(memory), resourceId: RESOURCE });
    expect(res.threads.map((t) => t.id)).toEqual(["mine"]);
  });
});

describe("deleteThread", () => {
  it("is a no-op for a stateless agent", async () => {
    const res = await deleteThread({
      agent: fakeAgent(null),
      threadId: "t1",
      resourceId: RESOURCE,
    });
    expect(res).toEqual({ deleted: false });
  });

  it("deletes an owned thread", async () => {
    const deleted: string[] = [];
    const memory = fakeMemory({
      threads: [thread()],
      onDelete: (id) => deleted.push(id),
    });
    const res = await deleteThread({
      agent: fakeAgent(memory),
      threadId: "t1",
      resourceId: RESOURCE,
    });
    expect(res).toEqual({ deleted: true });
    expect(deleted).toEqual(["t1"]);
  });

  it("refuses to delete a thread owned by another resource", async () => {
    let called = false;
    const memory = fakeMemory({
      threads: [thread({ id: "t1", resourceId: "other" })],
      onDelete: () => (called = true),
    });
    const res = await deleteThread({
      agent: fakeAgent(memory),
      threadId: "t1",
      resourceId: RESOURCE,
    });
    expect(res).toEqual({ deleted: false });
    expect(called).toBe(false);
  });

  it("is a no-op for an unknown thread", async () => {
    const memory = fakeMemory({ threads: [] });
    const res = await deleteThread({
      agent: fakeAgent(memory),
      threadId: "missing",
      resourceId: RESOURCE,
    });
    expect(res).toEqual({ deleted: false });
  });
});

describe("renameThread", () => {
  it("returns null for a stateless agent", async () => {
    const res = await renameThread({
      agent: fakeAgent(null),
      threadId: "t1",
      resourceId: RESOURCE,
      title: "Renamed",
    });
    expect(res).toBeNull();
  });

  it("renames an owned thread and echoes the updated wire shape", async () => {
    const updates: { id: string; title: string; metadata: unknown }[] = [];
    const memory = fakeMemory({
      threads: [thread({ metadata: { pinned: true } })],
      onUpdate: (args) => updates.push(args),
    });
    const res = await renameThread({
      agent: fakeAgent(memory),
      threadId: "t1",
      resourceId: RESOURCE,
      title: "Renamed",
    });
    expect(res).toEqual({
      id: "t1",
      title: "Renamed",
      resourceId: RESOURCE,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
      metadata: { pinned: true },
    });
    // Existing metadata is preserved through the update (Mastra replaces
    // the row, so the route must pass it back in).
    expect(updates).toEqual([
      { id: "t1", title: "Renamed", metadata: { pinned: true } },
    ]);
  });

  it("refuses to rename a thread owned by another resource", async () => {
    let called = false;
    const memory = fakeMemory({
      threads: [thread({ id: "t1", resourceId: "other" })],
      onUpdate: () => (called = true),
    });
    const res = await renameThread({
      agent: fakeAgent(memory),
      threadId: "t1",
      resourceId: RESOURCE,
      title: "Renamed",
    });
    expect(res).toBeNull();
    expect(called).toBe(false);
  });

  it("returns null for an unknown thread", async () => {
    const memory = fakeMemory({ threads: [] });
    const res = await renameThread({
      agent: fakeAgent(memory),
      threadId: "missing",
      resourceId: RESOURCE,
      title: "Renamed",
    });
    expect(res).toBeNull();
  });
});
