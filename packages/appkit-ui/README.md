# @dbx-tools/appkit-ui

Shared UI foundation for `@dbx-tools/*` feature packages (`appkit-email-ui`,
`appkit-mastra-ui`, ...). Centralizes the React / AppKit UI peer
dependencies and the Streamdown stylesheet every feature UI reuses.

## Install

Feature UI packages depend on this transitively. Host apps still need
`@databricks/appkit-ui`, `react`, and `react-dom` (provided via this
package's optional dependencies when installed through a feature UI
package).

```bash
npm install @dbx-tools/appkit-mastra-ui
```

## Styles

`./styles.css` imports Tailwind v4, Streamdown base CSS, and the shiki
token shim. Feature UI stylesheets `@import` it and add their own
`@source` directives. Host apps import the feature package's
`./styles.css` entry (see that package's README).

## Vite

Host apps that build with Vite import the shared plugin bundle so
Tailwind and React refresh resolve from this package:

```ts
import { appkitUiVitePlugins } from "@dbx-tools/appkit-ui/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: appkitUiVitePlugins(),
});
```

Declare `@dbx-tools/appkit-ui` and `vite` on the host; the Tailwind
toolchain stays on `appkit-ui`.

## React

Re-exports `@databricks/appkit-ui/react` for convenience:

```ts
import { Button, cn } from "@dbx-tools/appkit-ui/react";
```

## License

Apache-2.0
