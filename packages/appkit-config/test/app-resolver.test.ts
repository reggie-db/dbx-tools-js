import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { flattenAppEnv } from "../src/app-resolver.js";

const fixturePath = join(import.meta.dir, "fixtures", "bundle-validate-beta.json");
const bundleFixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("flattenAppEnv", () => {
  test("resolves literal and value_from entries when app key is pinned", () => {
    const env = flattenAppEnv(bundleFixture, "racetrac-si-app");
    expect(env.LAKEBASE_ENDPOINT).toBe(
      "projects/racetrac-si-beta/branches/production/endpoints/primary",
    );
    expect(env.PGDATABASE).toBe("databricks_postgres");
    expect(env.DATABRICKS_WAREHOUSE_ID).toBe("b087b375a8f43baa");
    expect(env.DATABRICKS_GENIE_SPACE_ID).toBe("01f11e89f9f115a7b62f8ae1f4d1091d");
  });

  test("auto-picks the only app when bundle has one app", () => {
    const env = flattenAppEnv(bundleFixture);
    expect(env.LAKEBASE_ENDPOINT).toBe(
      "projects/racetrac-si-beta/branches/production/endpoints/primary",
    );
  });

  test("returns {} when multiple apps exist and no key is provided", () => {
    const multiApp = {
      resources: {
        apps: {
          "app-a": bundleFixture.resources.apps["racetrac-si-app"],
          "app-b": { config: { env: [{ name: "OTHER", value: "x" }] } },
        },
      },
    };
    expect(flattenAppEnv(multiApp)).toEqual({});
  });

  test("returns {} for invalid bundle payloads", () => {
    expect(flattenAppEnv(null)).toEqual({});
    expect(flattenAppEnv({ resources: {} })).toEqual({});
  });
});
