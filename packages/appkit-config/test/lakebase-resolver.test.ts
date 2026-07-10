import { afterEach, describe, expect, test } from "bun:test";

import { readLakebaseInputs } from "../src/lakebase-resolver.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
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
