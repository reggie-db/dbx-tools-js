/**
 * `@dbx-tools/sdk-shared`: zod schemas + inferred TypeScript
 * types regenerated from upstream `.d.ts` declarations.
 *
 * Codegen owns `./generated/` end to end (see `package.json`'s
 * `codegen` field for the input list and
 * `bun scripts/codegen.ts` for the driver). This barrel is the
 * stable, hand-tracked entry point - it mirrors the convention the
 * other workspace packages follow (`./index.ts` -> `./dist/...`)
 * so the publish merge picks up the standard `package.default.json`
 * `exports` map without any per-package wiring.
 */

export * from "./generated/index.js";
