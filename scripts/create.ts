#!/usr/bin/env bun
// Scaffolds a new workspace package under `packages/<slug>/`, matching
// the minimal shape `mastra-shared` settled on:
//
//   packages/<slug>/
//     package.json         (name, version, module, type, optional deps)
//     tsconfig.build.json  (one-liner extending the root build config)
//     index.ts             (root barrel - what `module: "index.ts"` points at)
//     src/<slug>.ts        (plugin) or src/protocol.ts (shared)
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
//     `@dbx-tools/appkit-shared` for logger / plugin helpers.
//   - `shared`: pure-types package with a `src/protocol.ts` seed.
//     Zero runtime deps so the file is safe to import from browser
//     bundles.
//
// Usage:
//   bun run create plugin <slug>     e.g. bun run create plugin example
//   bun run create shared <slug>     e.g. bun run create shared example-shared
//
// Naming derivations from the kebab-case `<slug>`:
//   - npm name:        @dbx-tools/appkit-<slug>       (example -> @dbx-tools/appkit-example)
//   - directory:       packages/<slug>                (example -> packages/example)
//   - class name:      PascalCase(<slug>) + Plugin    (example -> ExamplePlugin)   [plugin only]
//   - export const:    camelCase(<slug>)              (example -> example)         [plugin only]
//   - displayName:     "Title Case <slug>"            (example -> "Example")       [plugin only]
//   - manifest name:   <slug> verbatim                                              [plugin only]

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Command, InvalidArgumentError } from "commander";
import { ROOT, writeJson } from "./util.js";

const SCOPE = "@dbx-tools";
const NPM_PREFIX = "appkit-";
// AppKit's version range lives in the root `catalog` (see root
// package.json). Scaffolded plugins reference it via `catalog:` so
// bumping happens in one place.
const APPKIT_PEER_RANGE = "catalog:";
const SHARED_PKG = `${SCOPE}/${NPM_PREFIX}shared`;

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
const pkgDir = resolve(ROOT, "packages", slug);
if (existsSync(pkgDir)) {
  console.error(`packages/${slug} already exists; aborting.`);
  process.exit(1);
}

const parts = slug.split("-");
const pascal = parts.map((s) => s[0]!.toUpperCase() + s.slice(1)).join("");
const camel = pascal[0]!.toLowerCase() + pascal.slice(1);
const className = `${pascal}Plugin`;
const displayName = parts.map((s) => s[0]!.toUpperCase() + s.slice(1)).join(" ");
const pkgName = `${SCOPE}/${NPM_PREFIX}${slug}`;

// `package.json`: the bare minimum mastra-shared settled on. Bun reads
// `module` to resolve the entry; nothing else is needed for workspace
// resolution or `bun install`. Plugins also pre-declare the AppKit peer
// + the shared utils dep so consumers don't have to wire them.
const basePackageJson = {
  name: pkgName,
  version: "0.1.0",
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
  // from `src/<slug>.js` (NodeNext-emitted `.js` extension - the
  // tsconfig.build.json compiles src/ into dist/ so the runtime path is
  // `.js`, even though the file on disk is `.ts`).
  const indexTs = `export { ${className}, ${camel} } from "./src/${slug}.js";\n`;

  const pluginTs = `import {
  Plugin,
  toPlugin,
  type IAppRouter,
  type PluginManifest,
} from "@databricks/appkit";

const manifest: PluginManifest<"${slug}"> = {
  name: "${slug}",
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
    //   res.json({ message: "Hello from ${slug}" });
    // });
  }
}

export const ${camel} = toPlugin(${className});
`;

  write(resolve(pkgDir, "index.ts"), indexTs);
  write(resolve(pkgDir, "src", `${slug}.ts`), pluginTs);

  console.log(`Scaffolded packages/${slug}/ (plugin, npm name ${pkgName})`);
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

  console.log(`Scaffolded packages/${slug}/ (shared, npm name ${pkgName})`);
  console.log(`Run \`bun install\` to link the workspace.`);
}
