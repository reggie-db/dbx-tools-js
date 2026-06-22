#!/usr/bin/env bun
// Scaffolds a new workspace package under `packages/<dir>/`, matching
// the minimal shape `mastra-shared` settled on:
//
//   packages/<dir>/
//     package.json         (name, version, module, type, optional deps)
//     tsconfig.build.json  (one-liner extending the root build config)
//     index.ts             (root barrel - what `module: "index.ts"` points at)
//     index.client.ts      (shared only - browser-safe barrel)
//     src/<dir>.ts          (plugin / standard) or src/protocol.ts (shared)
//
// For `plugin`, `<dir>` is always `appkit-<bare>` (the script
// auto-prefixes `appkit-`). For `shared`, `<dir>` is the slug verbatim.
// See "Naming derivations" below.
//
// Notable absences vs. typical npm scaffolds:
//   - no `files`, `scripts`, `main`, `types` on package.json (shared
//     does get an `exports` map for its browser/server split).
//   - no per-package `tsconfig.json` (typecheck flows through the
//     consumer's compile graph - currently the demo's tsconfigs).
//   - no `src/index.ts`. The root `index.ts` IS the barrel; src/ holds
//     only real source modules.
//   - dev deps are not duplicated per package; they live at the root
//     and bun hoists them into every workspace's `node_modules`.
//
// Three kinds, selected by flag:
//   - `--plugin`: AppKit Plugin subclass with an inline manifest. Lists
//     `@databricks/appkit` as a peer dependency and depends on
//     `@dbx-tools/shared` for logger / plugin helpers.
//   - `--shared`: browser-safe package with a server entry (`index.ts`)
//     and a browser entry (`index.client.ts`) wired through an
//     `exports` map, mirroring `@dbx-tools/shared`. Seeds a
//     `src/protocol.ts` types module. Zero runtime deps so the browser
//     barrel is safe to import from client bundles.
//   - none (default): a standard package with a single `index.ts`
//     barrel re-exporting a `src/<slug>.ts` seed.
//
// `--plugin` and `--shared` are mutually exclusive (passing both is an
// error).
//
// Usage:
//   bun run create <slug>            e.g. bun run create example
//   bun run create --plugin <slug>   e.g. bun run create --plugin example
//   bun run create --shared <slug>   e.g. bun run create --shared example-shared
//
// Naming derivations.
//
// `shared` / `standard`:
//   - npm name:        @dbx-tools/<slug>              (example -> @dbx-tools/example)
//   - directory:       packages/<slug>                (example -> packages/example)
//
// `plugin` (auto-prefixed with `appkit-` so every plugin npm name is
// `@dbx-tools/appkit-<bare>`; the prefix is stripped back off for the
// in-process manifest name since the runtime addresses plugins by
// their bare name):
//   - bare slug:       <slug> with any leading `appkit-` stripped
//                                                     (appkit-foo -> foo, foo -> foo)
//   - prefixed slug:   `appkit-<bare>`                (foo -> appkit-foo)
//   - npm name:        @dbx-tools/<prefixed>          (foo -> @dbx-tools/appkit-foo)
//   - directory:       packages/<prefixed>            (foo -> packages/appkit-foo)
//   - class name:      PascalCase(<prefixed>) + Plugin (foo -> AppkitFooPlugin)
//   - export const:    camelCase(<prefixed>)          (foo -> appkitFoo)
//   - displayName:     "Title Case <prefixed>"        (foo -> "Appkit Foo")
//   - file name:       src/<prefixed>.ts              (foo -> src/appkit-foo.ts)
//   - manifest name:   <bare>                         (foo -> "foo")
//
// Passing either form works: `bun run create plugin foo` and
// `bun run create plugin appkit-foo` both produce `packages/appkit-foo`
// with a manifest `name: "foo"`. The bare-vs-prefixed split exists
// because the npm side wants the package to read as an AppKit plugin
// (`appkit-foo`) while the runtime addresses plugins by their short
// name (`foo`).
//
// The initial `version` is derived from the publishable packages
// themselves (not hardcoded, not a mirrored label). That keeps a
// freshly scaffolded package in lockstep with the changesets `fixed`
// group, so the next `changeset version` / `tag` bumps it alongside
// everyone else.

import { Command, InvalidArgumentError } from "commander";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import semver from "semver";
import { discoverPackages, fail, ROOT_DIR, writeJson } from "./util.js";

const SCOPE = "@dbx-tools";
// AppKit's version range lives in the root `catalog` (see root
// package.json). Scaffolded plugins reference it via `catalog:` so
// bumping happens in one place.
const APPKIT_PEER_RANGE = "catalog:";
const SHARED_PKG = `${SCOPE}/shared`;

// Canonical "main" version for the monorepo: the version the fixed
// `@dbx-tools/*` group is currently on. Read straight off the
// publishable packages (the same set `tag` / `release` operate on) and
// take the highest, so a freshly scaffolded package starts in lockstep
// with the rest and the next release bumps it alongside everyone else.
// Reading the packages directly - rather than a mirrored label - means
// create can't fall behind when a release path forgets to update it.
const publishedVersions = (await discoverPackages())
  .map((pkg) => pkg.meta.version)
  .filter((version): version is string => Boolean(version));
const INITIAL_VERSION = publishedVersions.reduce<string | undefined>(
  (highest, version) => (!highest || semver.gt(version, highest) ? version : highest),
  undefined,
);
if (!INITIAL_VERSION) {
  fail(
    "no publishable packages with a `version` found to derive the initial version from",
  );
}

type Kind = "plugin" | "shared" | "standard";

/** Create a file (and any missing parent dirs) with the given content. */
function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const program = new Command()
  .name("create")
  .description("Scaffold a new workspace package under packages/<slug>/.")
  .option("--plugin", "scaffold an AppKit plugin package")
  .option("--shared", "scaffold a browser-safe shared package (index + index.client)")
  .argument("<slug>", "kebab-case slug (lowercase, starts with a letter)", (value) => {
    if (!/^[a-z][a-z0-9-]*$/.test(value)) {
      throw new InvalidArgumentError(`invalid slug "${value}"`);
    }
    return value;
  })
  .parse(process.argv);

const opts = program.opts<{ plugin?: boolean; shared?: boolean }>();
if (opts.plugin && opts.shared) {
  fail("pass at most one of --plugin or --shared, not both");
}

// No flag falls through to a standard package.
const kind: Kind = opts.plugin ? "plugin" : opts.shared ? "shared" : "standard";
const [slug] = program.processedArgs as [string];

// Plugins auto-prefix `appkit-` so the npm/folder/class names all
// read as AppKit plugins; the manifest `name` keeps the bare slug
// because the runtime addresses plugins by their short name. Shared
// packages pass through verbatim.
const bareSlug = kind === "plugin" ? slug.replace(/^appkit-/, "") : slug;
const dirSlug = kind === "plugin" ? `appkit-${bareSlug}` : slug;

const pkgDir = resolve(ROOT_DIR, "packages", dirSlug);
if (existsSync(pkgDir)) {
  console.error(`packages/${dirSlug} already exists; aborting.`);
  process.exit(1);
}

const parts = dirSlug.split("-");
const pascal = parts.map((s) => s[0]!.toUpperCase() + s.slice(1)).join("");
const camel = pascal[0]!.toLowerCase() + pascal.slice(1);
const className = `${pascal}Plugin`;
const displayName = parts.map((s) => s[0]!.toUpperCase() + s.slice(1)).join(" ");
const pkgName = `${SCOPE}/${dirSlug}`;

// `package.json`: the bare minimum mastra-shared settled on. Bun reads
// `module` to resolve the entry; nothing else is needed for workspace
// resolution or `bun install`. Plugins also pre-declare the AppKit peer
// + the shared utils dep so consumers don't have to wire them.
const basePackageJson = {
  name: pkgName,
  version: INITIAL_VERSION,
  module: "index.ts",
  type: "module" as const,
};

const pluginPackageJson = {
  ...basePackageJson,
  dependencies: {
    [SHARED_PKG]: "workspace:*",
  },
  peerDependencies: {
    "@databricks/appkit": APPKIT_PEER_RANGE,
  },
};

// Shared packages ship a browser/server split: the `exports` map points
// browser-aware bundlers at `index.client.{ts,js}` and Node at
// `index.{ts,js}`. `source` is listed FIRST and exposes the unbuilt
// `.ts` entries so in-repo tooling (which activates the `source`
// condition via the root tsconfig's `customConditions`) compiles
// straight from source instead of stale `dist/*.d.ts`. Condition
// matching is order-sensitive, so `source` must precede `types` /
// `import` / `default`. Mirrors the `@dbx-tools/shared` package.json.
const sharedPackageJson = {
  ...basePackageJson,
  exports: {
    ".": {
      source: {
        browser: "./index.client.ts",
        default: "./index.ts",
      },
      browser: {
        types: "./dist/index.client.d.ts",
        default: "./dist/index.client.js",
      },
      import: {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
      default: {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    },
  },
};

// Standard packages depend on `@dbx-tools/shared` (workspace) out of the
// box so consumers get the logger / plugin helpers without wiring them.
const standardPackageJson = {
  ...basePackageJson,
  dependencies: {
    [SHARED_PKG]: "workspace:*",
  },
};

const packageJson =
  kind === "plugin"
    ? pluginPackageJson
    : kind === "shared"
      ? sharedPackageJson
      : standardPackageJson;
const tsconfigBuild = { extends: "../../tsconfig.build.json" };

// `Bun.write` (used inside `writeJson`) creates the parent dir for us,
// but we touch siblings via `write()` (mkdirSync) below, so call
// `mkdirSync` explicitly to make the writes order-independent.
mkdirSync(pkgDir, { recursive: true });
await writeJson(resolve(pkgDir, "package.json"), packageJson);
await writeJson(resolve(pkgDir, "tsconfig.build.json"), tsconfigBuild);

if (kind === "plugin") {
  // Root barrel: one line that re-exports the plugin and its factory
  // from `src/<dirSlug>.js` (NodeNext-emitted `.js` extension - the
  // tsconfig.build.json compiles src/ into dist/ so the runtime path is
  // `.js`, even though the file on disk is `.ts`).
  const indexTs = `export { ${className}, ${camel} } from "./src/${dirSlug}.js";\n`;

  const pluginTs = `import {
  Plugin,
  toPlugin,
  type IAppRouter,
  type PluginManifest,
} from "@databricks/appkit";

const manifest: PluginManifest<"${bareSlug}"> = {
  name: "${bareSlug}",
  displayName: "${displayName}",
  description: "",
  stability: "beta",
  resources: {
    required: [],
    optional: [],
  },
};

export class ${className} extends Plugin {
  static manifest = manifest;

  injectRoutes(router: IAppRouter): void {
    // Add your routes here, e.g.:
    // router.get("/", (_req, res) => {
    //   res.json({ message: "Hello from ${dirSlug}" });
    // });
  }
}

export const ${camel} = toPlugin(${className});
`;

  write(resolve(pkgDir, "index.ts"), indexTs);
  write(resolve(pkgDir, "src", `${dirSlug}.ts`), pluginTs);

  console.log(
    `Scaffolded packages/${dirSlug}/ (plugin, npm name ${pkgName}, manifest name "${bareSlug}")`,
  );
  console.log(`Run \`bun install\` to link the workspace.`);
} else if (kind === "shared") {
  // Shared package: a server entry (`index.ts`) and a browser entry
  // (`index.client.ts`), wired through the `exports` map above, both
  // re-exporting from a single seed protocol module. Mirrors
  // `@dbx-tools/shared`.
  const indexClientTs = `/**
 * Browser-safe entry point for ${pkgName}. Pure types and browser-safe
 * runtime only - no \`node:*\` imports, even transitively, so this
 * barrel is safe to pull into a client bundle.
 *
 * Resolution: the package's \`exports\` map points the \`browser\` and
 * \`source.browser\` conditions at this file, so browser-aware bundlers
 * pick it up automatically while Node uses \`index.ts\`. Add new
 * browser-safe exports here.
 */
export type {} from "./src/protocol.js";
`;

  const indexTs = `/**
 * Server-side entry point for ${pkgName}. Re-exports the browser-safe
 * \`index.client.ts\` barrel and is the place to add server-only
 * namespaces (anything that imports \`node:*\` or pulls in a node-only
 * subtree). Keeping those here keeps \`index.client.ts\` safe for client
 * bundles.
 */
export * from "./index.client.js";
`;

  const protocolTs = `// Wire-format types for ${pkgName}. Pure types: no
// runtime dependencies, no Node-only imports, safe for browser bundles.
//
// Add your shared types below and re-export them from \`../index.client.ts\`.
`;

  write(resolve(pkgDir, "index.ts"), indexTs);
  write(resolve(pkgDir, "index.client.ts"), indexClientTs);
  write(resolve(pkgDir, "src", "protocol.ts"), protocolTs);

  console.log(`Scaffolded packages/${dirSlug}/ (shared, npm name ${pkgName})`);
  console.log(`Run \`bun install\` to link the workspace.`);
} else {
  // Standard package: a single barrel re-exporting a seed source module.
  const indexTs = `export * from "./src/${dirSlug}.js";\n`;

  const sourceTs = `// Source module for ${pkgName}.
//
// Add your exports below and re-export them from \`../index.ts\`.
export {};
`;

  write(resolve(pkgDir, "index.ts"), indexTs);
  write(resolve(pkgDir, "src", `${dirSlug}.ts`), sourceTs);

  console.log(`Scaffolded packages/${dirSlug}/ (standard, npm name ${pkgName})`);
  console.log(`Run \`bun install\` to link the workspace.`);
}
