import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { configUtils } from "@dbx-tools/shared";

import { resolveConfigValue } from "../src/config-value.js";
import { readLakebaseInputs } from "../src/lakebase-resolver.js";

const fixturePath = join(import.meta.dir, "fixtures", "bundle-validate-beta.json");
const bundleFixture = JSON.parse(readFileSync(fixturePath, "utf8")) as configUtils.BundleValidateJson;

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  configUtils.clearBundleConfigCache();
});

describe("resolveConfigValue", () => {
  test("prefers env over bundle", async () => {
    process.env.LAKEBASE_ENDPOINT = "from-env";
    expect(
      await resolveConfigValue("LAKEBASE_ENDPOINT", { bundleData: bundleFixture }),
    ).toBe("from-env");
  });

  test("falls back to bundle app env", async () => {
    delete process.env.LAKEBASE_ENDPOINT;
    expect(
      await resolveConfigValue("LAKEBASE_ENDPOINT", {
        bundleData: bundleFixture,
        sources: ["bundle"],
      }),
    ).toBe("projects/racetrac-si-beta/branches/production/endpoints/primary");
  });

  test("skips bundle validate inside a Databricks App", async () => {
    const prior = {
      DATABRICKS_APP_NAME: process.env.DATABRICKS_APP_NAME,
      DATABRICKS_HOST: process.env.DATABRICKS_HOST,
      DATABRICKS_APP_PORT: process.env.DATABRICKS_APP_PORT,
      LAKEBASE_ENDPOINT: process.env.LAKEBASE_ENDPOINT,
    };
    process.env.DATABRICKS_APP_NAME = "racetrac-si-app";
    process.env.DATABRICKS_HOST = "https://adb-123.azuredatabricks.net";
    process.env.DATABRICKS_APP_PORT = "8000";
    process.env.LAKEBASE_ENDPOINT = "from-runtime-env";
    try {
      expect(
        await resolveConfigValue("LAKEBASE_ENDPOINT", {
          bundleData: bundleFixture,
          sources: ["env", "bundle"],
        }),
      ).toBe("from-runtime-env");
    } finally {
      for (const [key, value] of Object.entries(prior)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  test("falls back to bundle variables", async () => {
    delete process.env.postgres_project_id;
    delete process.env.POSTGRES_PROJECT_ID;
    expect(
      await resolveConfigValue("postgres_project_id", {
        bundleData: bundleFixture,
        sources: ["bundle"],
      }),
    ).toBe("racetrac-si-beta");
  });

  test("cli is opt-in and wins when enabled", async () => {
    process.env.LAKEBASE_ENDPOINT = "from-env";
    expect(
      await resolveConfigValue("LAKEBASE_ENDPOINT", {
        bundleData: bundleFixture,
        sources: configUtils.withCliSources(),
        cli: { LAKEBASE_ENDPOINT: "from-cli" },
      }),
    ).toBe("from-cli");
  });

  test("explicit overrides when listed first", async () => {
    expect(
      await resolveConfigValue("chat_model", {
        bundleData: bundleFixture,
        sources: ["explicit", "env", "bundle"],
        explicit: { chat_model: "override-model" },
      }),
    ).toBe("override-model");
  });
});

describe("readLakebaseInputs bundle fallback", () => {
  test("uses env without bundle validate when inputs are complete", async () => {
    process.env.LAKEBASE_ENDPOINT =
      "projects/my-app/branches/production/endpoints/primary";
    process.env.PGHOST = "ep.example.database.databricks.net";
    process.env.PGDATABASE = "databricks_postgres";

    const inputs = await readLakebaseInputs({});
    expect(inputs.endpoint).toBe(
      "projects/my-app/branches/production/endpoints/primary",
    );
    expect(inputs.host).toBe("ep.example.database.databricks.net");
    expect(inputs.database).toBe("databricks_postgres");
  });
});
