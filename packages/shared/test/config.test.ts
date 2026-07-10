import { describe, expect, it } from "bun:test";

import * as configUtils from "../src/config.js";

describe("getBundlePath", () => {
  it("reads bundle variable value objects", () => {
    const data = {
      variables: {
        postgres_project_id: { value: "racetrac-si-beta" },
        chat_model: { value: "databricks-claude-sonnet-4-5" },
      },
    };
    expect(configUtils.getBundlePath(data, "variables.postgres_project_id")).toBe(
      "racetrac-si-beta",
    );
    expect(configUtils.getBundlePath(data, "variables.chat_model")).toBe(
      "databricks-claude-sonnet-4-5",
    );
  });
});

describe("resolveConfigValue", () => {
  it("reads from env by default", async () => {
    process.env.MY_TEST_CONFIG_VALUE = "from-env";
    expect(await configUtils.resolveConfigValue("MY_TEST_CONFIG_VALUE")).toBe("from-env");
    delete process.env.MY_TEST_CONFIG_VALUE;
  });

  it("skips bundle and app.yaml inside a Databricks App", async () => {
    const prior = {
      DATABRICKS_APP_NAME: process.env.DATABRICKS_APP_NAME,
      DATABRICKS_HOST: process.env.DATABRICKS_HOST,
      DATABRICKS_APP_PORT: process.env.DATABRICKS_APP_PORT,
      MY_BUNDLE_ONLY_VALUE: process.env.MY_BUNDLE_ONLY_VALUE,
    };
    process.env.DATABRICKS_APP_NAME = "my-app";
    process.env.DATABRICKS_HOST = "https://adb-123.azuredatabricks.net";
    process.env.DATABRICKS_APP_PORT = "8000";
    process.env.MY_BUNDLE_ONLY_VALUE = "from-env";
    try {
      expect(
        await configUtils.resolveConfigValue("MY_BUNDLE_ONLY_VALUE", {
          sources: ["bundle", "env"],
        }),
      ).toBe("from-env");
      expect(await configUtils.bundle()).toBeUndefined();
      expect(await configUtils.appYaml()).toBeUndefined();
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

  it("appends explicit to sources when provided", async () => {
    expect(
      await configUtils.resolveConfigValue("ONLY_IN_EXPLICIT", {
        explicit: { ONLY_IN_EXPLICIT: "from-explicit" },
      }),
    ).toBe("from-explicit");
  });

  it("reads the first non-empty explicit array value", async () => {
    expect(
      await configUtils.resolveConfigValue("MULTI_VALUE", {
        explicit: { MULTI_VALUE: ["", "  ", "first", "second"] },
      }),
    ).toBe("first");
  });
});
