#!/bin/sh
cd /Users/reggie.pierce/Projects/github-reggie-db/dbx-tools-js
echo "=== COMMAND 1 ==="
/usr/bin/git log v0.1.85..v0.1.87 --oneline --no-merges
echo "=== COMMAND 2 ==="
/usr/bin/git log v0.1.85..v0.1.87 --format='%s' --no-merges
echo "=== COMMAND 3 ==="
/usr/bin/git diff v0.1.85..v0.1.87 -- packages/appkit-mastra-ui/src/react/bubbles.tsx packages/devkit/src/cursor.ts packages/devkit/src/cursor-agent.ts packages/devkit/src/index.ts packages/devkit/src/tag.ts
