/**
 * Browser bundle for the demo client.
 *
 * Tailwind v4 runs through `@tailwindcss/cli` (handles `@source` in the
 * feature UI stylesheets), then Bun bundles `index.html` for the browser.
 * AppKit serves `client/dist` via `server({ staticPath })`.
 */
import { rmSync, watch } from "node:fs";
import path from "node:path";

const root = import.meta.dirname;
const watchMode = Bun.argv.includes("--watch");
const generatedCss = path.join(root, "src/.generated/app.css");
const outdir = path.join(root, "dist");

const build = async () => {
  await Bun.$`bunx @tailwindcss/cli -i ${path.join(root, "src/index.css")} -o ${generatedCss}`;

  const result = await Bun.build({
    conditions: ["source", "browser", "default"],
    entrypoints: [path.join(root, "index.html")],
    minify: process.env.NODE_ENV === "production",
    outdir,
    target: "browser",
    tsconfig: path.join(root, "tsconfig.json"),
  });

  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
};

if (watchMode) {
  await build();

  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleBuild = () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      void build();
    }, 100);
  };

  watch(path.join(root, "src"), { recursive: true }, scheduleBuild);
  watch(path.join(root, "index.html"), scheduleBuild);
} else {
  rmSync(outdir, { recursive: true, force: true });
  await build();
}
