#!/usr/bin/env bun
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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

const SCOPE = "@dbx-tools";
const NPM_PREFIX = "appkit-";
const APPKIT_PEER_RANGE = "^0.35";
const SHARED_PKG = `${SCOPE}/${NPM_PREFIX}shared`;
const ROOT = resolve(import.meta.dirname, "..");

type Kind = "plugin" | "shared";

function usage(message?: string): never {
  if (message) console.error(message);
  console.error("Usage:");
  console.error("  bun run create plugin <slug>");
  console.error("  bun run create shared <slug>");
  console.error("");
  console.error("  <slug> must be lowercase kebab-case and start with a letter.");
  process.exit(1);
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const kindArg = process.argv[2]?.trim();
const rawSlug = process.argv[3]?.trim();

if (kindArg !== "plugin" && kindArg !== "shared") {
  usage(`First arg must be "plugin" or "shared" (got "${kindArg ?? ""}").`);
}
const kind: Kind = kindArg;

if (!rawSlug || !/^[a-z][a-z0-9-]*$/.test(rawSlug)) {
  usage(`Invalid slug "${rawSlug ?? ""}".`);
}

const slug = rawSlug;
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

write(resolve(pkgDir, "package.json"), JSON.stringify(packageJson, null, 2) + "\n");
write(
  resolve(pkgDir, "tsconfig.build.json"),
  JSON.stringify(tsconfigBuild, null, 2) + "\n",
);

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
