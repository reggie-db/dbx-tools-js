import { describe, expect, test } from "bun:test";

import { agentStorageSchemaName } from "../src/storage-schema.js";

describe("agentStorageSchemaName", () => {
  test("maps kebab-case agent ids to valid Postgres identifiers", () => {
    expect(agentStorageSchemaName("data-mesh-book-assistant")).toBe(
      "mastra_data_mesh_book_assistant",
    );
  });

  test("stays within Postgres identifier length limit", () => {
    const longId = "a".repeat(80);
    expect(agentStorageSchemaName(longId).length).toBeLessThanOrEqual(63);
    expect(agentStorageSchemaName(longId)).toMatch(/^mastra_[a-z0-9_]+$/);
  });
});
