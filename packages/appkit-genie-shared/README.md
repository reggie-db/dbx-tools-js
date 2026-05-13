# @dbx-tools/appkit-genie-shared

Pure-type package that holds the wire-format contracts shared between [`@dbx-tools/appkit-genie`](../appkit-genie) (server plugin) and [`@dbx-tools/appkit-genie-ui`](../appkit-genie-ui) (React component).

Currently exports `ToolProgressEvent` and `ToolProgressPhase`. No runtime, no Node-only imports - safe to bundle into the browser.

The two consumer packages depend on this via `workspace:*` so there is exactly one definition site for every shared type. If you add a new endpoint or SSE event contract, define it here and both packages pick it up automatically on the next install.
