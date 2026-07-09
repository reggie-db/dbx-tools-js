import { defineConfig } from "tsdown";

/** Inline monorepo `@dbx-tools/*` sources; keep npm deps (incl. native addons) external. */
function isWorkspacePackage(id: string): boolean {
  return id.startsWith("@dbx-tools/");
}

export default defineConfig({
  entry: "server/server.ts",
  external: (id) => !id.startsWith(".") && !id.startsWith("/") && !isWorkspacePackage(id),
  format: "esm",
  minify: process.env.NODE_ENV === "production",
  noExternal: isWorkspacePackage,
  tsconfig: "tsconfig.server.json",
  outExtensions: () => ({
    js: ".js",
  }),
});
