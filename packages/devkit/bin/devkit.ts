#!/usr/bin/env bun

// `devkit` CLI: a thin commander dispatcher over the toolkit's command
// functions. Each subcommand parses its options and delegates to the
// matching `src/*.ts` function, which is also exported from the package
// root for programmatic use.

import { Command, InvalidArgumentError } from "commander";
import { build } from "../src/build.js";
import { codegen } from "../src/codegen.js";
import { create } from "../src/create.js";
import { format } from "../src/format.js";
import { release } from "../src/release.js";
import { tag, type Bump, type TagOptions } from "../src/tag.js";
import { verify } from "../src/verify.js";

const program = new Command()
  .name("devkit")
  .description("Workspace build, scaffold, and release toolkit for Bun monorepos.");

program
  .command("format")
  .description("syncpack format, regroup lifecycle hooks, then prettier --write.")
  .action(format);

program
  .command("build")
  .description("Compile every publishable package with the shared tsdown config.")
  .action(build);

program
  .command("release")
  .description("Build, then publish each package with a stamped (complete) manifest.")
  .option("-n, --dry-run", "rehearse with `bun publish --dry-run`", false)
  .action(async (opts: { dryRun: boolean }) => {
    await release({ dryRun: opts.dryRun });
  });

program
  .command("codegen")
  .description("Regenerate each package's `generated/` zod tree from its inputs.")
  .action(codegen);

program
  .command("verify")
  .description("Fail on imports of sibling packages not declared as dependencies.")
  .action(verify);

program
  .command("create")
  .description("Scaffold a new workspace package under packages/<slug>/.")
  .argument("<slug>", "kebab-case slug (lowercase, starts with a letter)", (value) => {
    if (!/^[a-z][a-z0-9-]*$/.test(value)) {
      throw new InvalidArgumentError(`invalid slug "${value}"`);
    }
    return value;
  })
  .option("--plugin", "scaffold an AppKit plugin package")
  .option("--shared", "scaffold a browser-safe shared package")
  .action(async (slug: string, opts: { plugin?: boolean; shared?: boolean }) => {
    await create({ slug, plugin: opts.plugin, shared: opts.shared });
  });

program
  .command("tag")
  .description("Bump every workspace, commit, tag HEAD, and push to origin.")
  .argument(
    "[bump]",
    "version bump (patch | minor | major)",
    (value): Bump => {
      if (value !== "patch" && value !== "minor" && value !== "major") {
        throw new InvalidArgumentError("expected patch, minor, or major");
      }
      return value;
    },
    "patch" as Bump,
  )
  .option("--no-publish", "skip publishing the tagged versions to the local registry")
  .option(
    "-n, --dry-run",
    "print the plan and release-notes preview; write nothing, push nothing",
    false,
  )
  .option(
    "--notes-since <tag>",
    "baseline tag for release notes (e.g. v0.1.75 or 0.1.75); defaults to the latest tag",
  )
  .action(async (bump: Bump, opts: TagOptions) => {
    await tag({
      bump,
      ...opts,
    });
  });

await program.parseAsync(process.argv);
