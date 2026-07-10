import { describe, expect, test } from "bun:test";

import {
  defaultEnvExportFormat,
  diffEnv,
  formatEnvExport,
  parseEnvExportFormat,
  snapshotEnv,
} from "../src/env-export.js";

describe("diffEnv", () => {
  test("returns added and changed keys only", () => {
    expect(
      diffEnv(
        { PGHOST: "old", PGPORT: "5432", UNCHANGED: "x" },
        { PGHOST: "new", PGPORT: "5432", PGDATABASE: "db", UNCHANGED: "x" },
      ),
    ).toEqual({ PGDATABASE: "db", PGHOST: "new" });
  });

  test("ignores removed or emptied values", () => {
    expect(diffEnv({ PGHOST: "host" }, {})).toEqual({});
    expect(diffEnv({ PGHOST: "host" }, { PGHOST: "" })).toEqual({});
  });
});

describe("formatEnvExport", () => {
  const sample = { PGHOST: "ep.example.net", PGDATABASE: "databricks_postgres" };

  test("posix export lines", () => {
    expect(formatEnvExport(sample, "export")).toBe(
      'export PGDATABASE="databricks_postgres"\nexport PGHOST="ep.example.net"\n',
    );
  });

  test("escapes export values", () => {
    expect(formatEnvExport({ TOKEN: 'say "hi" $USER' }, "export")).toBe(
      'export TOKEN="say \\"hi\\" \\$USER"\n',
    );
  });

  test("windows set", () => {
    expect(formatEnvExport(sample, "windows")).toBe(
      "set PGDATABASE=databricks_postgres\nset PGHOST=ep.example.net\n",
    );
  });

  test("json", () => {
    expect(formatEnvExport(sample, "json")).toBe(
      `${JSON.stringify({ PGDATABASE: "databricks_postgres", PGHOST: "ep.example.net" }, null, 2)}\n`,
    );
  });

  test("empty diff prints nothing", () => {
    expect(formatEnvExport({}, "json")).toBe("");
  });
});

describe("parseEnvExportFormat", () => {
  test("accepts shell aliases for export", () => {
    expect(parseEnvExportFormat("nix")).toBe("export");
    expect(parseEnvExportFormat("shell")).toBe("export");
  });

  test("accepts windows aliases", () => {
    expect(parseEnvExportFormat("cmd")).toBe("windows");
  });
});

describe("snapshotEnv", () => {
  test("copies defined env entries", () => {
    const env = { FOO: "bar", EMPTY: undefined, BAZ: "qux" };
    expect(snapshotEnv(env)).toEqual({ FOO: "bar", BAZ: "qux" });
  });
});

describe("defaultEnvExportFormat", () => {
  test("picks windows on win32", () => {
    expect(defaultEnvExportFormat("win32")).toBe("windows");
  });

  test("picks export elsewhere", () => {
    expect(defaultEnvExportFormat("darwin")).toBe("export");
  });
});
