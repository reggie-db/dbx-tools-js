# @dbx-tools/appkit-autopg

`autopg()` is a one-line helper that fills in every Lakebase Postgres
env var the AppKit `lakebase` plugin needs from whatever fragments your
deployment actually carries. Run it once before `createApp(...)` and stop
hand-rolling connection strings:

```ts
import { createApp, lakebase, server } from "@databricks/appkit";
import { autopg } from "@dbx-tools/appkit-autopg";

await autopg();
await createApp({ plugins: [server(), lakebase()] });
```

## Why a top-level helper instead of an AppKit plugin

AppKit's `static phase` field orders plugin `setup()` _invocation_, not
async _completion_. `lakebase.setup()` synchronously throws on a missing
`PGHOST` after its first `await`, so a sibling plugin that performs REST
discovery during `setup()` races and loses every time. Awaiting
`autopg()` before `createApp(...)` sidesteps the race - by the time any
plugin runs, `process.env` is fully populated.

## What it accepts

`autopg()` looks at, in priority order:

1. Explicit `autopg({ project, branch, endpoint, database, host, port, sslMode, autoCreate })`
2. Env vars - the same ones `lakebase` already reads:
   - `LAKEBASE_PROJECT`, `LAKEBASE_BRANCH`, `LAKEBASE_ENDPOINT`
   - `PGHOST`, `PGDATABASE`, `PGPORT`, `PGSSLMODE`
3. Whatever the address parser can recover from
   `LAKEBASE_ENDPOINT` / `config.endpoint`

The address input is permissive - any of these work:

```bash
# Canonical resource path
LAKEBASE_ENDPOINT="projects/dbx-tools/branches/main/endpoints/primary"

# Full Postgres URI (auth, host, db, sslmode all extracted)
LAKEBASE_ENDPOINT="postgresql://me%40databricks.com@ep-foo.database.azuredatabricks.net/databricks_postgres?sslmode=require"

# Bare Lakebase hostname (resolver reverse-looks-up the project)
LAKEBASE_ENDPOINT="ep-steep-forest-e199v43w.database.eastus2.azuredatabricks.net"

# Bare project id (resolver picks the default branch + endpoint + db)
LAKEBASE_ENDPOINT="dbx-tools"
```

## Three resolution modes

After parsing, the resolver fills gaps in this order:

1. **Reverse-lookup** - given just a host, scan
   `projects` -> `branches` -> `endpoints` for a matching
   `status.hosts.host` and recover the owning resource path.
2. **Pick default** - given a `project` (and optionally a `branch`),
   prefer the server-marked default child (`status.default`,
   `ENDPOINT_TYPE_READ_WRITE`, `databricks_postgres`) and fall back to
   "the only one" when a listing returns a single result.
3. **Auto-create** - when no projects exist at all, create one whose id
   defaults to a slugified `projectUtils.name()` (override with
   `autoCreate: "my-id"` or disable with `autoCreate: false`). The
   create call is idempotent: an `ALREADY_EXISTS` response from a
   concurrent boot is treated as success. Then poll the default
   endpoint until `current_state` is `READY` or `IDLE`.

## Options

```ts
await autopg({
  // Skip writing process.env (just inspect the returned record).
  exportEnv: false,
  // Pin individual fields - any of these short-circuit the resolver.
  project: "dbx-tools",
  branch: "main",
  endpoint: "projects/dbx-tools/branches/main/endpoints/primary",
  database: "databricks_postgres",
  // Auto-create behavior.
  autoCreate: false, // throw if no project exists
  // autoCreate: "my-custom-id", // create with this id
});
```

`autopg()` returns a `Resolved` record (`project`, `branch`, `endpoint`,
`database`, `host`, `port`, `sslMode`). When `exportEnv: true` (the
default) it also writes the same values to `process.env`, only filling
gaps - existing values are preserved.

## Address parser

The address parser is exported as well if you want it without the
resolver wrapper:

```ts
import { parseAddress } from "@dbx-tools/appkit-autopg";

parseAddress("postgresql://user@ep-foo.database.azuredatabricks.net/dbpg");
// { user, host, database, port?, sslMode?, project?, branch?, endpointId? }
```

## Required permissions

The Databricks user / SP behind `getWorkspaceClient()` needs
`postgres.projects.{list,create}`, `postgres.branches.list`,
`postgres.endpoints.{list,get}`, and `postgres.databases.list` on the
account.

## License

Apache-2.0
