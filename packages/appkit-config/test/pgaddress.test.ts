import { describe, expect, test } from "bun:test";

import { parseAddress, parseResourcePath } from "../src/pgaddress.js";

describe("parseAddress", () => {
  describe("empty / invalid", () => {
    test.each([undefined, null, "", "   ", "!!!", "with spaces"])(
      "returns {} for %p",
      (input) => {
        expect(parseAddress(input as string | undefined)).toEqual({});
      },
    );
  });

  describe("postgres URI", () => {
    test("full URI with user, host, db, sslmode", () => {
      const url =
        "postgresql://reggie.pierce%40databricks.com@ep-steep-forest-e199v43w.database.eastus2.azuredatabricks.net/databricks_postgres?sslmode=require";
      expect(parseAddress(url)).toEqual({
        user: "reggie.pierce@databricks.com",
        host: "ep-steep-forest-e199v43w.database.eastus2.azuredatabricks.net",
        database: "databricks_postgres",
        sslMode: "require",
      });
    });

    test("postgres:// scheme also works", () => {
      expect(parseAddress("postgres://user@host.example.com/mydb")).toEqual({
        user: "user",
        host: "host.example.com",
        database: "mydb",
      });
    });

    test("custom port", () => {
      const out = parseAddress("postgresql://user@host:6543/db");
      expect(out.port).toBe(6543);
    });

    test("disable sslmode", () => {
      expect(parseAddress("postgres://u@h/d?sslmode=disable").sslMode).toBe("disable");
    });

    test("prefer sslmode", () => {
      expect(parseAddress("postgres://u@h/d?sslmode=prefer").sslMode).toBe("prefer");
    });

    test("unknown sslmode is dropped", () => {
      expect(parseAddress("postgres://u@h/d?sslmode=verify-ca").sslMode).toBe(
        undefined,
      );
    });

    test("missing database is fine", () => {
      const out = parseAddress("postgres://u@host.example.com");
      expect(out.host).toBe("host.example.com");
      expect(out.database).toBe(undefined);
    });

    test("camelCase sslMode query param also accepted", () => {
      expect(parseAddress("postgres://u@h/d?sslMode=require").sslMode).toBe("require");
    });
  });

  describe("resource paths", () => {
    test("endpoint path", () => {
      const p = "projects/my-app/branches/main/endpoints/primary";
      expect(parseAddress(p)).toEqual({
        project: "my-app",
        branch: "main",
        endpointId: "primary",
        endpoint: p,
      });
    });

    test("database path surfaces resource id separately from PGDATABASE", () => {
      expect(
        parseAddress("projects/my-app/branches/main/databases/db-resource"),
      ).toEqual({
        project: "my-app",
        branch: "main",
        databaseResourceId: "db-resource",
      });
    });

    test("branch path", () => {
      expect(parseAddress("projects/my-app/branches/main")).toEqual({
        project: "my-app",
        branch: "main",
      });
    });

    test("parseResourcePath ignores bare branch ids", () => {
      expect(parseResourcePath("production")).toEqual({});
    });

    test("project path", () => {
      expect(parseAddress("projects/my-app")).toEqual({ project: "my-app" });
    });

    test("malformed projects/ prefix returns {}", () => {
      expect(parseAddress("projects/")).toEqual({});
    });
  });

  describe("bare hostname", () => {
    test("Lakebase Azure host", () => {
      const h = "ep-steep-forest-e199v43w.database.eastus2.azuredatabricks.net";
      expect(parseAddress(h)).toEqual({ host: h });
    });

    test("any dotted hostname is treated as a host", () => {
      expect(parseAddress("foo.bar.baz")).toEqual({ host: "foo.bar.baz" });
    });
  });

  describe("bare project id", () => {
    test("simple id", () => {
      expect(parseAddress("dbx-tools")).toEqual({ project: "dbx-tools" });
    });

    test("single letter", () => {
      expect(parseAddress("a")).toEqual({ project: "a" });
    });

    test("uppercase rejected (project ids are lowercase)", () => {
      expect(parseAddress("MyProject")).toEqual({});
    });

    test("starts with digit rejected", () => {
      expect(parseAddress("9foo")).toEqual({});
    });

    test("trailing hyphen rejected", () => {
      expect(parseAddress("foo-")).toEqual({});
    });
  });

  test("trims leading/trailing whitespace", () => {
    expect(parseAddress("  projects/my-app  ")).toEqual({ project: "my-app" });
  });
});
