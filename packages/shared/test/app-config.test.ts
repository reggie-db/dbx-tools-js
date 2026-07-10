import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as configUtils from "../src/config.js";

const fixturePath = join(import.meta.dir, "fixtures", "bundle-validate-beta.json");
const bundleFixture = JSON.parse(readFileSync(fixturePath, "utf8")) as Record<string, unknown>;

const bundleFile = { path: "/fixture", data: bundleFixture };

describe("flattenAppEnv", () => {
  test("resolves literal and value_from entries for a single-app bundle", () => {
    const env = configUtils.flattenAppEnv(bundleFixture);
    expect(env.LAKEBASE_ENDPOINT).toBe(
      "projects/racetrac-si-beta/branches/production/endpoints/primary",
    );
    expect(env.PGDATABASE).toBe("databricks_postgres");
    expect(env.DATABRICKS_WAREHOUSE_ID).toBe("b087b375a8f43baa");
    expect(env.DATABRICKS_GENIE_SPACE_ID).toBe("01f11e89f9f115a7b62f8ae1f4d1091d");
  });

  test("returns {} when multiple apps exist", () => {
    const multiApp = {
      resources: {
        apps: {
          "app-a": (bundleFixture.resources as { apps: Record<string, unknown> }).apps[
            "racetrac-si-app"
          ],
          "app-b": { config: { env: [{ name: "OTHER", value: "x" }] } },
        },
      },
    };
    expect(configUtils.flattenAppEnv(multiApp)).toEqual({});
  });

  test("returns {} for invalid bundle payloads", () => {
    expect(configUtils.flattenAppEnv(null)).toEqual({});
    expect(configUtils.flattenAppEnv({ resources: {} })).toEqual({});
  });
});

describe("flattenAppYamlEnv", () => {
  test("reads literal env values", () => {
    const env = configUtils.flattenAppYamlEnv({
      env: [
        { name: "PGDATABASE", value: "databricks_postgres" },
        { name: "PGSSLMODE", value: "require" },
      ],
    });
    expect(env).toEqual({
      PGDATABASE: "databricks_postgres",
      PGSSLMODE: "require",
    });
  });

  test("resolves valueFrom against app.yaml resources", () => {
    const env = configUtils.flattenAppYamlEnv({
      env: [{ name: "LAKEBASE_ENDPOINT", valueFrom: "postgres" }],
      resources: [
        {
          name: "postgres",
          postgres: {
            endpoint: "projects/demo/branches/main/endpoints/primary",
          },
        },
      ],
    });
    expect(env.LAKEBASE_ENDPOINT).toBe("projects/demo/branches/main/endpoints/primary");
  });
});

describe("appYaml", () => {
  test("reads app.yaml from the bundle root", async () => {
    const root = mkdtempSync(join(tmpdir(), "shared-config-yaml-"));
    try {
      writeFileSync(
        join(root, "app.yaml"),
        "env:\n  - name: PGHOST\n    value: ep.example.database.databricks.net\n",
      );
      const file = await configUtils.appYaml(root);
      expect(file?.data).toEqual({
        env: [{ name: "PGHOST", value: "ep.example.database.databricks.net" }],
      });
      expect(file?.path).toBe(realpathSync(join(root, "app.yaml")));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reads app.yaml from a nested project root", async () => {
    const root = mkdtempSync(join(tmpdir(), "shared-config-yaml-src-"));
    try {
      const src = join(root, "demo");
      mkdirSync(src, { recursive: true });
      writeFileSync(
        join(src, "app.yaml"),
        "env:\n  - name: PGPORT\n    value: \"5433\"\n",
      );
      const file = await configUtils.appYaml(src);
      expect(file?.path).toBe(realpathSync(join(src, "app.yaml")));
      expect(configUtils.flattenAppYamlEnv(file?.data)).toEqual({ PGPORT: "5433" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("resolveConfigValue app env", () => {
  test("reads bundle app config.env", async () => {
    expect(
      await configUtils.resolveConfigValue("LAKEBASE_ENDPOINT", {
        bundleData: bundleFile,
        sources: ["bundle"],
      }),
    ).toBe("projects/racetrac-si-beta/branches/production/endpoints/primary");
  });

  test("reads hard-coded app.yaml env entries", async () => {
    expect(
      await configUtils.resolveConfigValue("PGHOST", {
        appData: {
          path: "/app.yaml",
          data: { env: [{ name: "PGHOST", value: "from-app-yaml" }] },
        },
        sources: ["bundle"],
      }),
    ).toBe("from-app-yaml");
  });

  test("bundle config.env overrides duplicate app.yaml keys", async () => {
    expect(
      await configUtils.resolveConfigValue("PGDATABASE", {
        bundleData: bundleFile,
        appData: {
          path: "/app.yaml",
          data: { env: [{ name: "PGDATABASE", value: "from-app-yaml" }] },
        },
        sources: ["bundle"],
      }),
    ).toBe("databricks_postgres");
  });

  test("does not read bundle variables", async () => {
    expect(
      await configUtils.resolveConfigValue("chat_model", {
        bundleData: bundleFile,
        sources: ["bundle"],
      }),
    ).toBeUndefined();
  });
});
