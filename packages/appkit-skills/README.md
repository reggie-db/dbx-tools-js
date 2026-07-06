# @dbx-tools/appkit-skills

AppKit plugin that caches GitHub-hosted [Agent Skills](https://github.com/anthropics/skills)
repositories and exposes them to Mastra agents. Set {@link skillWorkspace} on
agents so Mastra injects `<available_skills>` from each `SKILL.md` front matter
every turn and mounts `skill`, `skill_search`, and `skill_read` at runtime.

Parsing uses Mastra's `LocalSkillSource` (the same `SKILL.md` format OpenSkills
and Claude Code use). OpenSkills is a CLI installer for coding agents, not a
runtime library, so this package downloads GitHub archives directly.

## Quick start

```ts
import { createApp, server } from "@databricks/appkit";
import { skills, skillWorkspace } from "@dbx-tools/appkit-skills";
import { createAgent, mastra } from "@dbx-tools/appkit-mastra";

await createApp({
  plugins: [
    server(),
    skills({
      sources: [
        "databricks-solutions/ai-dev-kit#subdirectory=databricks-skills",
        "mastra-ai/skills@main#subdirectory=skills",
      ],
    }),
    mastra({
      agents: createAgent({
        instructions: "You build on Databricks.",
        workspace: skillWorkspace,
      }),
    }),
  ],
});
```

## Source formats

Each `sources` entry is a pip-style string or a structured object:

| Pip form | Meaning |
| --- | --- |
| `owner/repo` | Default branch `main`; skills subdir auto-discovered |
| `owner/repo@branch` | Pin git ref (branch, tag, or commit) |
| `owner/repo#subdirectory=path` | Pin the skills folder under the checkout |
| `owner/repo@branch#subdirectory=path` | Pin both ref and skills folder |

Structured objects still accept `github` / `url`, `ref`, `skillsSubdir`, and `id`.

Examples:

```ts
skills({
  sources: [
    "databricks-solutions/ai-dev-kit#subdirectory=databricks-skills",
    "mastra-ai/skills@main#subdirectory=skills",
    { github: "anthropics/skills", ref: "main", skillsSubdir: "skills" },
  ],
});
```

## Cache

Checkouts live under `~/.cache/dbx-tools/skills/<id>/repo` by default. A
cross-platform directory lock prevents concurrent corruption during refresh.
TTL defaults to 24 hours.

## Configuration

```ts
skills({
  cacheDir: "/tmp/skills-cache",
  ttlMs: 12 * 60 * 60 * 1000,
  workspaceId: "my-skills",
  workspaceName: "My Skills",
  sources: [/* ... */],
});
```
