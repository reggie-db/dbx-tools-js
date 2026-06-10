# @dbx-tools/shared

Shared utilities used by the other `@dbx-tools/appkit-*` plugins. The
package has zero AppKit runtime dependency (it lists `@databricks/appkit`
as a peer) so it's safe to consume from any plugin or app code.

Each utility module is exported as a namespace so call sites read
naturally and never collide with similarly named helpers from other
libraries:

```ts
import {
  apiUtils,
  appkitUtils,
  commonUtils,
  httpUtils,
  logUtils,
  netUtils,
  projectUtils,
  stringUtils,
} from "@dbx-tools/shared";
```

> `apiUtils`, `appkitUtils`, and `projectUtils` import Node-only modules
> (`@databricks/appkit`, `node:fs`) and are intentionally **not** re-exported
> from the browser entry. Vite / Webpack / esbuild builds that honor the
> `browser` condition will resolve `@dbx-tools/shared` to a barrel that
> omits all three - import them only from server-side code.

## `appkitUtils` - typed sibling-plugin lookup

AppKit's `this.context.getPlugins()` returns `ReadonlyMap<string, BasePlugin>`,
so every cross-plugin call ends up writing the same
`as InstanceType<ReturnType<typeof someFactory>["plugin"]>` cast.
`appkitUtils.instance` / `appkitUtils.require` absorb that boilerplate:

```ts
import { lakebase } from "@databricks/appkit";
import { appkitUtils } from "@dbx-tools/shared";

const lake = appkitUtils.instance(this.context, lakebase);
//    ^^ inferred as LakebasePlugin | undefined
const pool = lake?.exports().pool;

// Throws "<caller>: required plugin not registered: lakebase" when missing.
const pool2 = appkitUtils
  .require(this.context, lakebase, "mastra")
  .exports().pool;
```

`appkitUtils.data(factory)` caches the static `{ plugin, name }` descriptor
per factory so repeated lookups don't allocate. Use it directly when you
need the registered name for a manifest dependency.

## `httpUtils` - framework-neutral header helpers

Public surface: `forEachHeaderValue`, `parseCookies`. The header-shaped
helpers work uniformly against any of:

- Express `req` (Node-style `req.headers`)
- Web Fetch `Request` (`Headers` instance)
- Hono `Context.req` (`c.req.raw.headers`)
- `node:http` `IncomingMessage`
- Plain `Record<string, string | string[] | undefined>`

```ts
import { httpUtils } from "@dbx-tools/shared";

app.use((req, res, next) => {
  const session = httpUtils.parseCookies(req).session;

  // Walk every value of a (possibly repeated) header without committing
  // to a specific framework's accessor shape.
  let bearer: string | undefined;
  httpUtils.forEachHeaderValue(req, "authorization", (value) => {
    if (value.startsWith("Bearer ")) bearer = value.slice(7);
  });
});
```

## `netUtils` - URL builder + path matching + free-port helpers

Public surface: `urlBuilder`, `pathMatch`, plus the server-only
`getRandomPort`. The URL helpers are pure JS and ship in the
browser bundle too; `getRandomPort` binds a transient `node:net`
listener and is therefore server-only (importing `netUtils` from
the browser entry simply omits it).

```ts
import { netUtils } from "@dbx-tools/shared";

// Tolerant URL coercion into a chainable builder - bare hostnames,
// path-only strings, or objects with a `.url` field all round-trip
// through. Returns `null` on failure (matches WHATWG `URL.parse(...)`).
const url = netUtils.urlBuilder("example.com");  // https://example.com/

// Copy-on-write path joins: segments are trimmed of boundary slashes,
// blanks dropped, arrays flattened.
netUtils
  .urlBuilder("https://host")!
  .withPathAppend("/api/", ["v2", "items"]); // https://host/api/v2/items

// Segment-boundary prefix test (accepts any UrlLike, incl. a Request).
netUtils.pathMatch("/api/cool?q=1", "/api"); // true

// Grab a free local port (server only).
const port = await netUtils.getRandomPort();
```

## `apiUtils` - Databricks REST cancellation helpers (server only)

Network calls go through the workspace client's own
`apiClient.request` (it stamps the auth header and parses JSON), so
there's no bespoke `fetch` wrapper here. `apiUtils` just supplies the
cancellation glue around it: `toContext` adapts an `AbortSignal` (or
`AbortController`) into the SDK `Context` the request methods expect.

```ts
import { apiUtils } from "@dbx-tools/shared";
import { getExecutionContext } from "@databricks/appkit";

const { client } = getExecutionContext();

// Issue the call straight through the workspace client's apiClient -
// leading /api/2.0 is added for you by the SDK.
const data = (await client.apiClient.request({
  path: "/api/2.0/serving-endpoints",
  method: "GET",
  headers: new Headers(),
  raw: false,
})) as { endpoints?: unknown[] };

// Adapt an AbortSignal into the SDK Context the request accepts.
const context = apiUtils.toContext(abortSignal);
```

`toContext` returns a `Context` whose `cancellationToken` is backed by
the supplied signal, so aborting it tears down the in-flight SDK call.
Want TTL'd results? Wrap the call in `CacheManager.getOrExecute`.

## `stringUtils` - identifier + slug helpers

`toIdentifier` / `toSlug` are deterministic, length-bounded, and always
lower-case at the type level (the `lowerCase` option literal is fixed to
`true` so an explicit `false` is a compile error):

```ts
import { stringUtils } from "@dbx-tools/shared";

stringUtils.toIdentifier("My Cool Project!"); // "my-cool-project"
stringUtils.toSlug("My Cool Project!");       // "my-cool-project"

// Custom delimiter via toIdentifierWithOptions:
stringUtils.toIdentifierWithOptions(
  { delimiter: "_" },
  "My Cool Project!",
); // "my_cool_project"

stringUtils.toIdentifierWithOptions({ maxLength: 16 }, "very long project name");
// "very-long-2m8wk4"  <- hash suffix when truncated
```

## `projectUtils` - project name + git-remote parsing

```ts
import { projectUtils } from "@dbx-tools/shared";

// Discovers a stable name for the current project. Order:
// 1. `package.json` name (root of an npm/bun workspace if applicable)
// 2. Closest `git remote origin` repo name
// 3. Process `cwd` basename
const name = await projectUtils.name();

// Strip "owner/" + ".git" from a remote URL.
projectUtils.parseGitRemote("git@github.com:org/my-repo.git"); // "my-repo"
```

## `commonUtils` - memoize, ids, hashing, polling, error messages

```ts
import { commonUtils } from "@dbx-tools/shared";

// Memoize by all-args; sync results cache forever, async failures bust.
const fetchUser = commonUtils.memoize(async (id: string) => loadUser(id));

// Mint an id. With no arg, a full v4 UUID (use when global
// uniqueness matters - cross-process / cross-storage). Pass
// `length` for the first N hex chars of one (use for marker-
// friendly typeable ids bounded to a single conversation /
// batch).
commonUtils.id();  // "123e4567-e89b-12d3-a456-426614174000"
commonUtils.id(8); // "a3f1c92b"

// Short, deterministic hash for cache keys / slug suffixes / etc.
// Pure-JS FNV-1a in Crockford-style base-32 (digits + lowercase
// alphabet minus i/l/o/u). Browser-safe.
commonUtils.fnvHash("databricks-claude-sonnet-4-6"); // e.g. "k3p9q7"
commonUtils.fnvHashWithOptions({ length: 4 }, "user@example.com");

// Async generator that polls a producer on an interval. Yields each
// value; stops when `predicate` returns false or the signal aborts.
// `timeoutMs` caps the total loop lifetime - when it elapses the
// loop throws the `TimeoutError` from `AbortSignal.timeout(...)`.
for await (const status of commonUtils.poll(
  async ({ signal }) => fetchStatus(signal),
  { intervalMs: 250, timeoutMs: 30_000, predicate: (s) => s !== "ready" },
)) {
  render(status);
}

// Pull a printable message out of any thrown value. Folds the
// `err instanceof Error ? err.message : String(err)` dance into
// one helper for log attributes and similar contexts.
log.warn("write:error", { error: commonUtils.errorMessage(err) });
```

`@memoized` is a TC39 stage-1 method decorator built on the same
`memoize` (requires `experimentalDecorators: true` in `tsconfig.json`).
`fnvHash` is intentionally **not** cryptographically secure - use it for
keys and slugs, never for tokens or signatures.

## `logUtils` - tagged console logger

`logger(plugin)` returns a leveled `{ debug, info, warn, error }` interface
that auto-tags every line with the plugin's name:

```ts
import { logUtils } from "@dbx-tools/shared";

class MyPlugin extends Plugin<MyConfig> {
  private log = logUtils.logger(this); // tags as "[my-plugin]"
  override async setup() {
    this.log.info("setup", { mode: this.config.mode });
  }
}
```

The logger is intentionally console-backed (no extra deps). For richer
sinks pass your own `{ debug, info, warn, error }` object - the plugins
in this repo accept any matching shape.

### `LOG_LEVEL` filtering

Each call checks `process.env.LOG_LEVEL` (case-insensitive, default
`info`) and drops anything below the threshold *before* string
formatting, so leaving `log.debug({...heavy details})` calls in
production code costs nothing as long as `LOG_LEVEL` isn't `debug`.

```bash
LOG_LEVEL=debug bun dev    # full verbosity
LOG_LEVEL=warn  bun start  # production: hide info chatter
```

The lookup is per-call (not module-load), so test runners can flip
the threshold after the module has been imported. In browser bundles
where `process.env.LOG_LEVEL` is undefined, the default `info`
threshold applies.

## License

Apache-2.0
