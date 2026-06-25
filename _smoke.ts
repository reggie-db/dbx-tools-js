import deepmerge from "deepmerge";
import { cpSync, existsSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repo = process.cwd();
const distDir = resolve(repo, "packages/devkit/dist");
const ROOT_DEFAULTS = ["tsconfig.build.json", "package.default.json"];

for (const name of ROOT_DEFAULTS) {
  const src = resolve(repo, name);
  if (!existsSync(src)) continue;
  mkdirSync(distDir, { recursive: true });
  cpSync(src, resolve(distDir, `${name}.template`));
}
console.log("staged:", ROOT_DEFAULTS.map(n => existsSync(resolve(distDir, `${n}.template`))));

const tmp = "/tmp/smoke-consumer";
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const preferExistingArray = (_t: unknown[], e: unknown[]) => e;

function ensure(name: string) {
  const bundled = resolve(distDir, `${name}.template`);
  if (!existsSync(bundled)) return "skipped";
  const template = JSON.parse(readFileSync(bundled, "utf8"));
  const dest = resolve(tmp, name);
  if (!existsSync(dest)) { writeFileSync(dest, JSON.stringify(template, null, 2)); return "created"; }
  const existing = JSON.parse(readFileSync(dest, "utf8"));
  const merged = deepmerge(template, existing, { arrayMerge: preferExistingArray });
  writeFileSync(dest, JSON.stringify(merged, null, 2));
  return "merged";
}

console.log("tsconfig:", ensure("tsconfig.build.json"));
writeFileSync(resolve(tmp, "package.default.json"), JSON.stringify({
  main: "./build/index.js",
  exports: { ".": { default: "./build/index.js" } },
  files: ["only-this"],
}, null, 2));
console.log("pkg.default:", ensure("package.default.json"));
console.log(readFileSync(resolve(tmp, "package.default.json"), "utf8"));

rmSync(distDir, { recursive: true, force: true });
console.log("after dist removed:", ensure("tsconfig.build.json"));
