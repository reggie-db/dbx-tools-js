import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as configUtils from "../src/config.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  configUtils.clearBundleConfigCache();
});

describe("findBundleRoot", () => {
  it("finds databricks.yml under a project root candidate", async () => {
    const root = mkdtempSync(join(tmpdir(), "shared-config-"));
    tempDirs.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "bundle-app" }));
    writeFileSync(join(root, "databricks.yml"), "bundle:\n  name: test\n");

    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "package.json"), JSON.stringify({ name: "nested" }));

    expect(realpathSync((await configUtils.findBundleRoot(nested))!)).toBe(realpathSync(root));
  });

  it("returns undefined when no bundle manifest exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "shared-config-empty-"));
    tempDirs.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "no-bundle" }));

    expect(await configUtils.findBundleRoot(root)).toBeUndefined();
  });
});

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

  it("skips bundle validate inside a Databricks App", async () => {
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
      expect(await configUtils.loadBundleConfig()).toBeUndefined();
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
});
