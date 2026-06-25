#!/usr/bin/env bun

// `devkit` CLI: a thin commander dispatcher over the toolkit's command
// functions. Each subcommand parses its options and delegates to the
// matching `src/*.ts` function, which is also exported from the package
// root for programmatic use.

import { Command, InvalidArgumentError, Option } from "commander";
import { build } from "../src/build.js";
import { clean } from "../src/clean.js";
import { codegen } from "../src/codegen.js";
import { create } from "../src/create.js";
import { format } from "../src/format.js";
import { syncReadmes } from "../src/readme.js";
import { DEFAULT_REGISTRY, release } from "../src/release.js";
import { fail } from "../src/script.js";
import { tag, type Bump, type TagOptions } from "../src/tag.js";
import { typecheck } from "../src/typecheck.js";
import { verify } from "../src/verify.js";

const program = new Command()
  .name("devkit")
  .description("Workspace build, scaffold, and release toolkit for Bun monorepos.");

program
  .command("build")
  .description("Run the gate (codegen, format, verify, prune) then compile.")
  .action(build);

program
  .command("typecheck")
  .description("Flat `tsc --noEmit` over all packages, then the demo's own check.")
  .action(typecheck);

program
  .command("format")
  .description("syncpack format, regroup lifecycle hooks, then prettier --write.")
  .action(format);

program
  .command("codegen")
  .description("Regenerate each package's `generated/` zod tree from its inputs.")
  .action(codegen);

program
  .command("verify")
  .description("Fail on imports of sibling packages not declared as dependencies.")
  .action(verify);

program
  .command("clean")
  .description("Wipe dist/ and stale tsbuildinfo across the workspace.")
  .action(clean);

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
  .command("readme")
  .description("Generate or refresh README.md across publishable packages.")
  .option("-u, --upgrade", "regenerate READMEs that already exist", false)
  .option("-n, --dry-run", "print to stdout instead of writing", false)
  .option("-p, --package <name>", "limit to a single package by full name")
  .action(async (opts: { upgrade: boolean; dryRun: boolean; package?: string }) => {
    await syncReadmes({
      upgrade: opts.upgrade,
      dryRun: opts.dryRun,
      only: opts.package,
    });
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
  .option(
    "--readme",
    "sync package READMEs with source before the release commit",
    false,
  )
  .option("--no-publish", "skip publishing the tagged versions to the local registry")

  .addOption(
    new Option(
      "-r, --registry <url>",
      "local registry to publish the tagged versions to",
    )
      .env("NPM_REGISTRY")
      .default(DEFAULT_REGISTRY),
  )
  .action(async (bump: Bump, opts: TagOptions) => {
    await tag({
      bump,
      ...opts,
    });
  });

program
  .command("release")
  .description("Build then publish every public package (defaults to local Verdaccio).")
  .addOption(
    new Option("-r, --registry <url>", "registry to publish to")
      .env("NPM_REGISTRY")
      .default(DEFAULT_REGISTRY),
  )
  .option("--dry-run", "pack each package without uploading", false)
  .option("--otp <code>", "one-time password for 2FA-protected registries")
  .action(async (opts: { registry: string; dryRun: boolean; otp?: string }) => {
    const result = await release({
      ...opts,
    });
    if (result.failed > 0) fail(`${result.failed} package(s) failed to publish`);
  });

await program.parseAsync(process.argv);
