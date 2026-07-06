import { git } from "./packages/devkit/src/git.ts";

const repo = "/Users/reggie.pierce/Projects/github-reggie-db/dbx-tools-js";
const paths = [
  "packages/appkit-mastra-ui/src/react/bubbles.tsx",
  "packages/devkit/src/cursor.ts",
  "packages/devkit/src/cursor-agent.ts",
  "packages/devkit/src/index.ts",
  "packages/devkit/src/tag.ts",
];

const lines: string[] = [];

const log1 = await git(["log", "v0.1.85..v0.1.87", "--oneline", "--no-merges"], { cwd: repo });
lines.push("=== COMMAND 1 ===");
lines.push(log1.stdout);
if (log1.stderr) lines.push(log1.stderr);

const log2 = await git(["log", "v0.1.85..v0.1.87", "--format=%s", "--no-merges"], { cwd: repo });
lines.push("=== COMMAND 2 ===");
lines.push(log2.stdout);
if (log2.stderr) lines.push(log2.stderr);

const diff = await git(["diff", "v0.1.85..v0.1.87", "--", ...paths], { cwd: repo });
lines.push("=== COMMAND 3 ===");
lines.push(diff.stdout);
if (diff.stderr) lines.push(diff.stderr);

await Bun.write(`${repo}/.git-output.txt`, lines.join("\n"));
