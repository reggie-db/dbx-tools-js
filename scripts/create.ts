#!/usr/bin/env bun
// Scaffolds a new workspace package under `packages/<dir>/`, matching
// the minimal shape `mastra-shared` settled on:
//
//   packages/<dir>/
//     package.json         (name, version, module, type, optional deps)
//     tsconfig.build.json  (one-liner extending the root build config)
//     index.ts             (root barrel - what `module: "index.ts"` points at)
//     src/<dir>.ts         (plugin) or src/protocol.ts (shared)
//
// For `plugin`, `<dir>` is always `appkit-<bare>` (the script
// auto-prefixes `appkit-`). For `shared`, `<dir>` is the slug verbatim.
// See "Naming derivations" below.
//
// Notable absences vs. typical npm scaffolds:
//   - no `exports`, `files`, `scripts`, `main`, `types` on package.json
//   - no per-package `tsconfig.json` (typecheck flows through the
//     consumer's compile graph - currently the demo's tsconfigs).
//   - no `src/index.ts`. The root `index.ts` IS the barrel; src/ holds
//     only real source modules.
//   - dev deps are not duplicated per package; they live at the root
//     and bun hoists them into every workspace's `node_modules`.
//
// Two kinds:
//   - `plugin`: AppKit Plugin subclass with an inline manifest. Lists
//     `@databricks/appkit` as a peer dependency and depends on
//     `@dbx-tools/shared` for logger / plugin helpers.
//   - `shared`: pure-types package with a `src/protocol.ts` seed.
//     Zero runtime deps so the file is safe to import from browser
//     bundles.
//
// Usage:
//   bun run create plugin <slug>     e.g. bun run create plugin example
//   bun run create shared <slug>     e.g. bun run create shared example-shared
//
// Naming derivations.
//
// `shared`:
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
// The initial `version` is read off the root `package.json` instead
// of being hardcoded. That keeps a freshly scaffolded package in
// lockstep with the changesets `fixed` group, so the next
// `changeset version` bumps it alongside everyone else.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { fail, ROOT, writeJson, type PackageJson } from "./util.js";

const SCOPE = "@dbx-tools";
// AppKit's version range lives in the root `catalog` (see root
// package.json). Scaffolded plugins reference it via `catalog:` so
// bumping happens in one place.
const APPKIT_PEER_RANGE = "catalog:";
const SHARED_PKG = `${SCOPE}/shared`;

// Canonical "main" version for the monorepo. Lives on the root
// `package.json` (kept in sync with the changesets `fixed` group by
// `scripts/sync-version.ts`). New packages start here so they're
// already in lockstep with the rest of the workspace - the next
// `changeset version` will then bump them alongside everyone else.
const rootMeta = (await Bun.file(resolve(ROOT, "package.json")).json()) as PackageJson;
const INITIAL_VERSION = rootMeta.version;
if (!INITIAL_VERSION) {
  fail("root package.json has no `version` field; run `bun run sync-version` first");
}

type Kind = "plugin" | "shared";

/** Create a file (and any missing parent dirs) with the given content. */
function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const program = new Command()
  .name("create")
  .description("Scaffold a new workspace package under packages/<slug>/.")
  .argument(
    "<kind>",
    "package kind (plugin | shared)",
    (value): Kind => {
      if (value !== "plugin" && value !== "shared") {
        throw new InvalidArgumentError("expected plugin or shared");
      }
      return value;
    },
  )
  .argument(
    "<slug>",
    "kebab-case slug (lowercase, starts with a letter)",
    (value) => {
      if (!/^[a-z][a-z0-9-]*$/.test(value)) {
        throw new InvalidArgumentError(`invalid slug "${value}"`);
      }
      return value;
    },
  )
  .parse(process.argv);

const [kind, slug] = program.processedArgs as [Kind, string];

// Plugins auto-prefix `appkit-` so the npm/folder/class names all
// read as AppKit plugins; the manifest `name` keeps the bare slug
// because the runtime addresses plugins by their short name. Shared
// packages pass through verbatim.
const bareSlug = kind === "plugin" ? slug.replace(/^appkit-/, "") : slug;
const dirSlug = kind === "plugin" ? `appkit-${bareSlug}` : slug;

const pkgDir = resolve(ROOT, "packages", dirSlug);
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

const packageJson = kind === "plugin" ? pluginPackageJson : basePackageJson;
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
} else {
  // Shared package: barrel re-exports from a single seed protocol
  // module. Matches `mastra-shared`-style `src/protocol.ts` layout.
  const indexTs = `export type {} from "./src/protocol.js";\n`;

  const protocolTs = `// Wire-format types for ${pkgName}. Pure types: no
// runtime dependencies, no Node-only imports, safe for browser bundles.
//
// Add your shared types below and re-export them from \`../index.ts\`.
`;

  write(resolve(pkgDir, "index.ts"), indexTs);
  write(resolve(pkgDir, "src", "protocol.ts"), protocolTs);

  console.log(`Scaffolded packages/${dirSlug}/ (shared, npm name ${pkgName})`);
  console.log(`Run \`bun install\` to link the workspace.`);
}
