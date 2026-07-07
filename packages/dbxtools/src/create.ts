// Scaffolds a new workspace package under `packages/<dir>/`, matching
// the minimal shape this monorepo settled on:
//
//   packages/<dir>/
//     package.json         (name, version, type, one-line `exports`, deps)
//     src/index.ts          (barrel - what `exports["."]` points at)
//     src/<dir>.ts          (plugin / standard) or src/protocol.ts (shared)
//
// The slim manifest is filled out at publish time (`dbxtools release`
// stamps `main`/`types`/`files`/`license` and expands the `exports`
// pointer into its `source`/`types`/`default` shape); there is no
// per-package `build`/`publish` script because `dbxtools build` /
// `dbxtools release` drive every package through the shared tsdown config.
//
// For `plugin`, `<dir>` is always `appkit-<bare>` (the command
// auto-prefixes `appkit-`). For `shared`, `<dir>` is the slug verbatim.
// See "Naming derivations" below.
//
// Three kinds, selected by flag:
//   - `--plugin`: AppKit Plugin subclass with an inline manifest. Lists
//     `@databricks/appkit` as a peer dependency and depends on the
//     configured shared-helpers package (`dbxtools.sharedPackage`, default
//     `<scope>/shared`) for logger / plugin helpers when it exists.
//   - `--shared`: dependency-free, browser-safe contract package with a
//     single `src/index.ts` barrel re-exporting a `src/protocol.ts` seed.
//     Add an `index.client.ts` + `exports` split by hand only if the
//     package later needs server-only (`node:*`) code kept out of
//     browser bundles.
//   - none (default): a standard package with a single `src/index.ts`
//     barrel re-exporting a `src/<slug>.ts` seed.
//
// `--plugin` and `--shared` are mutually exclusive (passing both is an
// error).
//
// Naming derivations.
//
// `shared` / `standard`:
//   - npm name:        <scope>/<slug>              (example -> @scope/example)
//   - directory:       packages/<slug>             (example -> packages/example)
//
// `plugin` (auto-prefixed with `appkit-` so every plugin npm name is
// `<scope>/appkit-<bare>`; the prefix is stripped back off for the
// in-process manifest name since the runtime addresses plugins by
// their bare name):
//   - bare slug:       <slug> with any leading `appkit-` stripped
//   - prefixed slug:   `appkit-<bare>`
//   - npm name:        <scope>/<prefixed>
//   - directory:       packages/<prefixed>
//   - class name:      PascalCase(<prefixed>) + Plugin
//   - export const:    camelCase(<prefixed>)
//   - displayName:     "Title Case <prefixed>"
//   - file name:       src/<prefixed>.ts
//   - manifest name:   <bare>
//
// The initial `version` is derived from the publishable packages
// themselves (not hardcoded), keeping a freshly scaffolded package in
// lockstep with the changesets `fixed` group so the next version bump
// moves it alongside everyone else.

import { consola } from "consola";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import semver from "semver";
import { getDbxtoolsConfig } from "./config.js";
import { discoverPackages, toAbsolute, writeJson } from "./package.js";
import { fail } from "./script.js";

/** Options for {@link create}. */
export interface CreateOptions {
  /** kebab-case slug (lowercase, starts with a letter). */
  slug: string;
  /** Scaffold an AppKit plugin package. */
  plugin?: boolean;
  /** Scaffold a browser-safe shared package. */
  shared?: boolean;
}

type Kind = "plugin" | "shared" | "standard";

// AppKit's version range lives in the root `catalog`. Scaffolded
// plugins reference it via `catalog:` so bumping happens in one place.
const APPKIT_PEER_RANGE = "catalog:";

/** Create a file (and any missing parent dirs) with the given content. */
function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Scaffold a new workspace package under `packages/<slug>/`. */
export async function create(options: CreateOptions): Promise<void> {
  const { slug, plugin, shared } = options;
  if (plugin && shared) {
    fail("pass at most one of --plugin or --shared, not both");
  }
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
    fail(`invalid slug "${slug}" (lowercase kebab-case, must start with a letter)`);
  }

  const { scope, sharedPackage } = await getDbxtoolsConfig();
  if (!scope) {
    fail(
      "could not determine an npm scope; set `dbxtools.scope` in the root package.json",
    );
  }

  // Canonical "main" version for the monorepo: the version the fixed
  // group is currently on. Read straight off the publishable packages
  // and take the highest, so a freshly scaffolded package starts in
  // lockstep with the rest.
  const existingPackages = await discoverPackages();
  const publishedVersions = existingPackages
    .map((pkg) => pkg.meta.version)
    .filter((version): version is string => Boolean(version));

  // Only wire the shared-helpers dependency (config `sharedPackage`,
  // default `<scope>/shared`) when such a package actually exists in
  // this workspace, so scaffolding works in repos that don't follow the
  // shared-helpers convention.
  const hasSharedPkg =
    sharedPackage !== null &&
    existingPackages.some((pkg) => pkg.meta.name === sharedPackage);
  const initialVersion = publishedVersions.reduce<string | undefined>(
    (highest, version) => (!highest || semver.gt(version, highest) ? version : highest),
    undefined,
  );
  if (!initialVersion) {
    fail(
      "no publishable packages with a `version` found to derive the initial version from",
    );
  }

  const kind: Kind = plugin ? "plugin" : shared ? "shared" : "standard";

  // Plugins auto-prefix `appkit-` so the npm/folder/class names all read
  // as AppKit plugins; the manifest `name` keeps the bare slug because
  // the runtime addresses plugins by their short name. Shared packages
  // pass through verbatim.
  const bareSlug = kind === "plugin" ? slug.replace(/^appkit-/, "") : slug;
  const dirSlug = kind === "plugin" ? `appkit-${bareSlug}` : slug;

  const pkgDir = toAbsolute(`packages/${dirSlug}`);
  if (existsSync(pkgDir)) {
    fail(`packages/${dirSlug} already exists; aborting.`);
  }

  const capitalized = dirSlug.split("-").map((s) => s[0]!.toUpperCase() + s.slice(1));
  const pascal = capitalized.join("");
  const camel = pascal[0]!.toLowerCase() + pascal.slice(1);
  const className = `${pascal}Plugin`;
  const displayName = capitalized.join(" ");
  const pkgName = `${scope}/${dirSlug}`;

  // `package.json`: the bare minimum. The one-line `exports` pointer at
  // the package's own source is the single entry every tool (Node, tsc,
  // Vite, bun, tsdown) resolves; everything else a published tarball
  // needs is stamped in at release time. Scoped packages are public on
  // npm by default (the free plan does not cover private scoped pkgs).
  // Plugins also pre-declare the AppKit peer + the shared utils dep so
  // consumers don't have to wire them.
  const basePackageJson = {
    name: pkgName,
    version: initialVersion,
    type: "module" as const,
    exports: { ".": "./src/index.ts" },
    publishConfig: { access: "public" as const },
  };

  // Plugins and standard packages depend on the shared-helpers package
  // (workspace) out of the box so consumers get the logger / plugin
  // helpers without wiring them - but only when it exists in this
  // workspace.
  const sharedDep =
    hasSharedPkg && sharedPackage
      ? { dependencies: { [sharedPackage]: "workspace:*" } }
      : {};

  const pluginPackageJson = {
    ...basePackageJson,
    ...sharedDep,
    peerDependencies: {
      "@databricks/appkit": APPKIT_PEER_RANGE,
    },
  };

  // Shared packages are single-entry (`exports["."] -> ./src/index.ts`)
  // by default. The browser/server split (`index.client.ts` + a
  // conditional `exports` map) is added by hand only when a package
  // genuinely carries server-only code that must stay out of browser
  // bundles.
  const sharedPackageJson = {
    ...basePackageJson,
  };

  const standardPackageJson = {
    ...basePackageJson,
    ...sharedDep,
  };

  const packageJson =
    kind === "plugin"
      ? pluginPackageJson
      : kind === "shared"
        ? sharedPackageJson
        : standardPackageJson;

  // `Bun.write` (used inside `writeJson`) creates the parent dir for us,
  // but we touch siblings via `write()` (mkdirSync) below, so call
  // `mkdirSync` explicitly to make the writes order-independent.
  mkdirSync(pkgDir, { recursive: true });
  await writeJson(resolve(pkgDir, "package.json"), packageJson);

  if (kind === "plugin") {
    // `src/index.ts` barrel: one line that re-exports the plugin and its
    // factory from `./<dirSlug>.js` (the source file is `.ts`, and
    // bundler-style resolution follows the emitted `.js` specifier during
    // typecheck/build).
    const indexTs = `export { ${className}, ${camel} } from "./${dirSlug}.js";\n`;

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

    write(resolve(pkgDir, "src", "index.ts"), indexTs);
    write(resolve(pkgDir, "src", `${dirSlug}.ts`), pluginTs);

    consola.log(
      `Scaffolded packages/${dirSlug}/ (plugin, npm name ${pkgName}, manifest name "${bareSlug}")`,
    );
  } else if (kind === "shared") {
    // Shared package: one browser-safe `src/index.ts` barrel re-exporting
    // a seed protocol module.
    const indexTs = `/**
 * ${pkgName}: a dependency-free, browser-safe wire-format contract.
 * Pure types (and browser-safe runtime, e.g. zod) only - no \`node:*\`
 * imports, even transitively - so any runtime can import it.
 */
export * from "./protocol.js";
`;

    const protocolTs = `// Wire-format types for ${pkgName}. Pure types: no
// Node-only imports, safe for browser bundles.
//
// Add your shared types below and re-export them from \`./index.ts\`.
`;

    write(resolve(pkgDir, "src", "index.ts"), indexTs);
    write(resolve(pkgDir, "src", "protocol.ts"), protocolTs);

    consola.log(`Scaffolded packages/${dirSlug}/ (shared, npm name ${pkgName})`);
  } else {
    // Standard package: a single `src/index.ts` barrel re-exporting a seed
    // source module.
    const indexTs = `export * from "./${dirSlug}.js";\n`;

    const sourceTs = `// Source module for ${pkgName}.
//
// Add your exports below and re-export them from \`./index.ts\`.
export {};
`;

    write(resolve(pkgDir, "src", "index.ts"), indexTs);
    write(resolve(pkgDir, "src", `${dirSlug}.ts`), sourceTs);

    consola.log(`Scaffolded packages/${dirSlug}/ (standard, npm name ${pkgName})`);
  }

  consola.log(`Run \`bun install\` to link the workspace.`);
}
