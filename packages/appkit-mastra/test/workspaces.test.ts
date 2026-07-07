import { describe, expect, test } from "bun:test";

import { createWorkspace } from "../src/workspaces.js";

describe("createWorkspace", () => {
  test("defaults id and name to workspace", () => {
    const workspace = createWorkspace();
    expect(workspace.id).toBe("workspace");
    expect(workspace.name).toBe("workspace");
  });

  test("derives id from name when id is omitted", () => {
    const workspace = createWorkspace({ name: "Assistant Skills" });
    expect(workspace.id).toBe("assistant-skills");
    expect(workspace.name).toBe("Assistant Skills");
  });

  test("derives name from id when name is omitted", () => {
    const workspace = createWorkspace({ id: "assistant-skills" });
    expect(workspace.id).toBe("assistant-skills");
    expect(workspace.name).toBe("assistant skills");
  });
});
