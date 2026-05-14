#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Scaffolds a new workspace package under `packages/<slug>/`. Two kinds:
//
//   - `plugin`: empty AppKit Plugin subclass with inline manifest, modeled
//     after `memory`. After files are written, `bun add` is invoked
//     twice in the new package dir so `@databricks/appkit` lands in both
//     `peerDependencies` and `devDependencies` at whatever version bun
//     currently resolves (no hard-coded version that can drift).
//
//   - `shared`: pure-types package with a barrel `index.ts` and a
//     `protocol.ts` seed file, modeled after `genie-shared`. No
//     `@databricks/appkit` dep is added - shared packages are intentionally
//     runtime-free so browser bundles can import them.
//
// Usage:
//   bun run create plugin <slug>     e.g. bun run create plugin example
//   bun run create shared <slug>     e.g. bun run create shared example-shared
//
// Naming derivations from the kebab-case `<slug>`:
//   - npm name:        @dbx-tools/appkit-<slug>     (example -> @dbx-tools/appkit-example)
//   - directory:       packages/<slug>              (example -> packages/example)
//   - class name:      PascalCase(<slug>) + Plugin  (example -> ExamplePlugin)   [plugin only]
//   - export const:    camelCase(<slug>)            (example -> example)         [plugin only]
//   - displayName:     "Title Case <slug>"          (example -> "Example")       [plugin only]
//   - manifest name:   <slug> verbatim                                            [plugin only]

const SCOPE = "@dbx-tools";
const NPM_PREFIX = "appkit-";
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

function bunAdd(cwd: string, flag: "--peer" | "--dev", pkg: string): void {
  // Inherit stdio so `bun add`'s install summary streams to the user.
  // `bun` resolves on PATH; the script itself is invoked via `bun run create`
  // so the binary is already present.
  const result = spawnSync("bun", ["add", flag, pkg], { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
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

// Same `package.json` / `tsconfig.json` shape for both kinds: every
// publishable package in the workspace already follows this template.
const packageJson = {
  name: pkgName,
  version: "0.1.0",
  license: "Apache-2.0",
  type: "module",
  main: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: {
    ".": {
      source: "./src/index.ts",
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    },
  },
  files: ["dist", "src"],
  scripts: { build: "tsc -p tsconfig.build.json" },
};

const tsconfigBuild = { extends: "../../tsconfig.build.json" };

write(
  resolve(pkgDir, "package.json"),
  JSON.stringify(packageJson, null, 2) + "\n",
);
write(
  resolve(pkgDir, "tsconfig.build.json"),
  JSON.stringify(tsconfigBuild, null, 2) + "\n",
);

if (kind === "plugin") {
  const indexTs = `export { ${className}, ${camel} } from "./${slug}";\n`;

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
    // this.route(router, {
    //   name: "example",
    //   method: "get",
    //   path: "/",
    //   handler: async (_req, res) => {
    //     res.json({ message: "Hello from ${slug}" });
    //   },
    // });
  }
}

export const ${camel} = toPlugin(${className});
`;

  write(resolve(pkgDir, "src", "index.ts"), indexTs);
  write(resolve(pkgDir, "src", `${slug}.ts`), pluginTs);

  console.log(`Scaffolded packages/${slug}/ (plugin, npm name ${pkgName})`);
  console.log("Installing @databricks/appkit as peer + dev dependency...");

  // Two passes because `bun add` flips between peer/dev/regular via its
  // flag and has no "add to both" mode. Each pass re-runs the workspace
  // install but it's cheap once the package is already cached.
  bunAdd(pkgDir, "--peer", "@databricks/appkit");
  bunAdd(pkgDir, "--dev", "@databricks/appkit");
} else {
  // Shared package: barrel re-exports from a single seed protocol module.
  // Matches `genie-shared/src/{index,protocol}.ts` exactly.
  const indexTs = `export type {} from "./protocol.js";\n`;

  const protocolTs = `// Wire-format types for ${pkgName}. Pure types: no
// runtime dependencies, no Node-only imports, safe for browser bundles.
//
// Add your shared types below and re-export them from \`./index.ts\`.
`;

  write(resolve(pkgDir, "src", "index.ts"), indexTs);
  write(resolve(pkgDir, "src", "protocol.ts"), protocolTs);

  console.log(`Scaffolded packages/${slug}/ (shared, npm name ${pkgName})`);
}

console.log(`Done. ${pkgName} is ready.`);
