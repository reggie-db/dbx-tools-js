# @dbx-tools/appkit-shared

Shared utilities used by the other `@dbx-tools/appkit-*` plugins. The
package has zero AppKit runtime dependency (it lists `@databricks/appkit`
as a peer) so it's safe to consume from any plugin or app code.

Each utility module is exported as a namespace so call sites read
naturally and never collide with similarly named helpers from other
libraries:

```ts
import {
  commonUtils,
  httpUtils,
  logUtils,
  pluginUtils,
  stringUtils,
} from "@dbx-tools/appkit-shared";
```

## `pluginUtils` - typed sibling-plugin lookup

AppKit's `this.context.getPlugins()` returns `ReadonlyMap<string, BasePlugin>`,
so every cross-plugin call ends up writing the same
`as InstanceType<ReturnType<typeof someFactory>["plugin"]>` cast.
`pluginUtils.instance` / `pluginUtils.require` absorb that boilerplate:

```ts
import { lakebase } from "@databricks/appkit";
import { pluginUtils } from "@dbx-tools/appkit-shared";

const lake = pluginUtils.instance(this.context, lakebase);
//    ^^ inferred as LakebasePlugin | undefined
const pool = lake?.exports().pool;

// Throws "<caller>: required plugin not registered: lakebase" when missing.
const pool2 = pluginUtils
  .require(this.context, lakebase, "mastra")
  .exports().pool;
```

`pluginUtils.data(factory)` caches the static `{ plugin, name }` descriptor
per factory so repeated lookups don't allocate. Use it directly when you
need the registered name for a manifest dependency.

## `httpUtils` - framework-neutral request helpers

`parseCookies` / `getHeader` / `parseAuthorization` work against any of:

- Express `req` (Node-style `req.headers`)
- Web Fetch `Request` (`Headers` instance)
- Hono `Context.req` (`req.header()`)
- `node:http` `IncomingMessage`
- Plain `Record<string, string | string[]>`

```ts
import { httpUtils } from "@dbx-tools/appkit-shared";

app.use((req, res, next) => {
  const session = httpUtils.parseCookies(req).session;
  const bearer = httpUtils.parseAuthorization(req)?.bearer;
  // ...
});
```

## `stringUtils` - identifier + slug helpers

`toIdentifier` / `toSlug` are deterministic, length-bounded, and always
lower-case at the type level (the `lowerCase` option literal is fixed to
`true` so an explicit `false` is a compile error):

```ts
import { stringUtils } from "@dbx-tools/appkit-shared";

stringUtils.toIdentifier("My Cool Project!"); // "my_cool_project"
stringUtils.toSlug("My Cool Project!"); // "my-cool-project"

stringUtils.toIdentifierWithOptions({ maxLength: 12 }, "very long project name");
// "very_long_43c1"  <- hash suffix when truncated
```

## `commonUtils` - project name + memoize

```ts
import { commonUtils } from "@dbx-tools/appkit-shared";

// Discovers a stable name for the current project. Order:
// 1. `package.json` name
// 2. Closest `git remote origin` repo name
// 3. Process `cwd` basename
const name = await commonUtils.projectName();

// Memoize by all-args; sync results cache forever, async failures bust.
const fetchUser = commonUtils.memoize(async (id: string) => loadUser(id));
```

`@memoized` is a TC39 stage-1 method decorator built on the same
`memoize` (requires `experimentalDecorators: true` in `tsconfig.json`).

## `logUtils` - tagged console logger

`logger(plugin)` returns a leveled `{ debug, info, warn, error }` interface
that auto-tags every line with the plugin's name:

```ts
import { logUtils } from "@dbx-tools/appkit-shared";

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

## License

Apache-2.0
