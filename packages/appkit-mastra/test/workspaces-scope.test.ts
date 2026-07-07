import { describe, expect, test } from "bun:test";
import { RequestContext } from "@mastra/core/request-context";
import { CompositeFilesystem } from "@mastra/core/workspace";

import {
  MASTRA_SCOPES_KEY,
  MASTRA_USER_EMAIL_KEY,
  MASTRA_USER_KEY,
} from "../src/config.js";
import { createWorkspace } from "../src/workspaces.js";

describe("createWorkspace assistant skill mounts", () => {
  test("returns empty filesystem without request context", async () => {
    const workspace = createWorkspace();
    const fs = await workspace.resolveFilesystem({
      requestContext: new RequestContext(),
    });
    expect(fs?.name).toBe("EmptyFilesystem");
  });

  test("returns empty filesystem in production without workspace scope", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const workspace = createWorkspace();
      const requestContext = new RequestContext();
      requestContext.set(MASTRA_SCOPES_KEY, ["sql"]);
      requestContext.set(MASTRA_USER_KEY, {
        id: "user-1",
        executionContext: { client: {} },
      });
      requestContext.set(MASTRA_USER_EMAIL_KEY, "alice@example.com");

      const fs = await workspace.resolveFilesystem({ requestContext });
      expect(fs?.name).toBe("EmptyFilesystem");
    } finally {
      process.env.NODE_ENV = previous;
    }
  });

  test("mounts shared and user skill trees when scope and client are present", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const workspace = createWorkspace();
      const requestContext = new RequestContext();
      requestContext.set(MASTRA_SCOPES_KEY, ["workspace"]);
      requestContext.set(MASTRA_USER_KEY, {
        id: "user-1",
        executionContext: { client: {} },
      });
      requestContext.set(MASTRA_USER_EMAIL_KEY, "alice@example.com");

      const resolved = await workspace.resolveFilesystem({ requestContext });
      expect(resolved).toBeInstanceOf(CompositeFilesystem);
      if (!(resolved instanceof CompositeFilesystem)) {
        throw new Error("expected CompositeFilesystem");
      }
      expect(resolved.mountPaths.sort()).toEqual([
        "/workspace_skills",
        "/workspace_user_skills",
      ]);
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
