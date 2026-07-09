# @dbx-tools/sdk-shared

Zod schemas plus inferred TypeScript types for the Databricks SDK
shapes the rest of the `@dbx-tools/*` packages consume. Everything
under `./generated/` is regenerated from upstream
`@databricks/sdk-experimental` `.d.ts` declarations by the
`dbxtools codegen` command (see
[`@dbx-tools/cli`](../cli)); nothing in here is
hand-maintained.

```ts
import {
  genieMessageSchema,
  genieAttachmentSchema,
  messageStatusSchema,
  type GenieMessage,
  type MessageStatus,
} from "@dbx-tools/sdk-shared";

// Parse / validate a wire payload.
const message = genieMessageSchema.parse(rawJson);

// Or just use the inferred type.
function format(m: GenieMessage): string {
  return `${m.status}: ${m.content}`;
}
```

The package has zero runtime dependency beyond `zod` itself. No
`WorkspaceClient`, no `node:*`, no SDK runtime - importing it from a
browser bundle is safe.

## What's inside

The single `dashboards` input expands to a schema + matching inferred
type per upstream shape, covering the Genie and Lakeview SDK surfaces
(conversations, messages, attachments, query results, suggested
questions, dashboard schedules, subscriptions, etc.). The generated
output lives at
[`./generated/dashboards.zod.ts`](./generated/dashboards.zod.ts) and
the package barrel at
[`./generated/index.ts`](./generated/index.ts).

For each upstream type the generator emits two exports:

| Export             | Shape                                      |
| ------------------ | ------------------------------------------ |
| `xxxSchema`        | `z.ZodType<X>` for runtime validation      |
| `Xxx` (type alias) | `z.infer<typeof xxxSchema>` for static use |

## How codegen works

Each consumer package declares its own `codegen.inputs` in
`package.json`:

```json
{
  "name": "@dbx-tools/sdk-shared",
  "codegen": {
    "inputs": [
      "node_modules/@databricks/sdk-experimental/dist/apis/dashboards/model.d.ts"
    ]
  }
}
```

`dbxtools codegen` walks every package with a `codegen` field
and, for each input:

1. Reads the upstream `.d.ts`.
2. Strips every `import` declaration and rewrites any type reference
   whose root identifier was introduced by one of those imports
   (`sql.StatementResponse`, `ApiClient`, ...) to `unknown`. The
   output is a pure data-shape surface; peer SDK runtime modules
   don't belong here.
3. Pipes the cleaned source into [`ts-to-zod`](https://github.com/fabien0102/ts-to-zod)
   to produce a `<name>.zod.ts` schema module.
4. Regenerates `generated/index.ts` as a barrel re-export of every
   schema module.

The whole `generated/` tree is gitignored (`generated/.gitignore`
holds `*`); the hand-tracked top-level `./index.ts` re-exports it so
the package manifest exposes the generated barrel without any generated-file wiring.

```ts
// index.ts
export * from "./generated/index.js";
```

## Regenerating

```bash
bun dbxtools codegen          # runs codegen across every package with a codegen field
# or invoke the toolkit directly:
dbxtools codegen
```

Codegen refuses to write or delete any file inside `generated/` that
isn't already gitignored at the start of the run, so manually
dropping a file into `generated/` without updating the ignore aborts
with a clear error instead of silently overwriting.

## Adding a new SDK surface

Append the upstream `.d.ts` path to `codegen.inputs` and rerun
codegen. Optionally append `=<basename>` to override the auto-derived
file name:

```json
{
  "codegen": {
    "inputs": [
      "node_modules/@databricks/sdk-experimental/dist/apis/dashboards/model.d.ts",
      "node_modules/@databricks/sdk-experimental/dist/apis/jobs/model.d.ts=jobs"
    ]
  }
}
```

That produces `generated/dashboards.zod.ts` and `generated/jobs.zod.ts`,
both re-exported by `generated/index.ts`.

## License

Apache-2.0
