# @dbx-tools/appkit-ai-dev-kit

Thin preset over [`@dbx-tools/appkit-skills`](../appkit-skills) that defaults to
the Field Engineering [AI Dev Kit](https://github.com/databricks-solutions/ai-dev-kit)
repository.

For multiple sources or custom GitHub URLs, use `@dbx-tools/appkit-skills` directly.

```ts
import { aiDevKit, skillWorkspace } from "@dbx-tools/appkit-ai-dev-kit";

await createApp({
  plugins: [
    aiDevKit(),
    mastra({
      agents: createAgent({ workspace: skillWorkspace, instructions: "..." }),
    }),
  ],
});
```

Equivalent generic wiring:

```ts
import { skills, skillWorkspace } from "@dbx-tools/appkit-skills";

skills({
  sources: [
    {
      github: "databricks-solutions/ai-dev-kit",
      ref: "main",
      skillsSubdir: "databricks-skills",
    },
  ],
});
```
