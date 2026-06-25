# @dbx-tools/model-proxy

A local, OpenAI-compatible proxy in front of Databricks Model Serving.
Point any tool that speaks the OpenAI API (iTerm, an editor, the
`openai` SDK, `curl`) at a loopback URL, type a loose model name like
`claude sonnet`, and the request is fuzzy-resolved to a real serving
endpoint, authenticated with a fresh workspace token, and forwarded to
Databricks.

```bash
# Start the proxy (defaults to 127.0.0.1:4000), auth via your
# Databricks SDK config / profile / OAuth login.
bunx --bun model-proxy serve --profile my-workspace

# In another shell, talk to it with the OpenAI wire format:
curl http://127.0.0.1:4000/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model": "claude sonnet", "messages": [{"role": "user", "content": "hi"}]}'
```

Configure an OpenAI client with `base_url = http://127.0.0.1:4000/v1`
and any API key (none is required unless you set one). The response
carries an `x-resolved-model` header so you can see which endpoint a
loose name snapped to.

## How it works

Databricks Model Serving already speaks the OpenAI schema at each
endpoint's `/invocations` route, so the proxy does not translate
formats. Each request only:

1. **Resolves the model.** The body's `model` is fuzzy-matched against
   the workspace's `/serving-endpoints` list via `@dbx-tools/model`, so
   `claude sonnet` -> `databricks-claude-sonnet-4-6`. The catalogue is
   listed once and reused for the process (re-listed on a miss, so a
   model deployed after start-up still resolves on first use) - no cache
   layer, just one lazy load.
2. **Mints a token.** The Databricks SDK `WorkspaceClient` is asked to
   authenticate every request, so short-lived OAuth tokens are refreshed
   transparently - the proxy never stores or manages a token itself.
3. **Pipes the response.** The upstream body (JSON or an SSE stream) is
   streamed straight back, so token-by-token streaming works unchanged.

## Auth

Authentication is whatever the Databricks SDK resolves from the
environment: `DATABRICKS_HOST` / `DATABRICKS_TOKEN`, a
`~/.databrickscfg` profile (`--profile`), OAuth U2M (`databricks auth
login`), service-principal M2M, Azure, or Google. Nothing
Databricks-specific is configured here beyond an optional host /
profile override.

To require callers to present a key, pass `--api-key` (or set
`PROXY_API_KEY`); clients must then send `Authorization: Bearer <key>`.

## CLI

```bash
model-proxy serve [--port 4000] [--host 127.0.0.1] [--profile <name>]
                  [--workspace-host <url>] [--threshold <0..1>] [--api-key <key>]
model-proxy chat  [--profile <name>] [--model "claude sonnet"] [--client "<cmd>"]
model-proxy models [--profile <name>]                 # list resolvable endpoints
model-proxy resolve claude sonnet [--profile <name>]  # show how a name resolves
```

### `chat`: proxy + terminal client in one shot

`chat` starts the proxy and hands off to an off-the-shelf, OpenAI-compatible
terminal client, pointing it at the proxy via `OPENAI_BASE_URL` /
`OPENAI_API_KEY` / `OPENAI_MODEL`. The default client is OpenHarness,
launched with `bunx @alhazmiai/openharness` (no global install needed);
swap it with `--client` or the `PROXY_CHAT_CLIENT` env var. Because
`--client` runs through your shell, it can carry its own args:

```bash
model-proxy chat --profile my-workspace --model "claude sonnet"
model-proxy chat --client "bunx @alhazmiai/openharness"  # the default, made explicit
model-proxy chat --client "aichat"          # any installed OpenAI-compatible CLI
```

When the client exits, the proxy shuts down with it.

## Programmatic use

```ts
import { DatabricksBackend, startProxyServer } from "@dbx-tools/model-proxy";

const backend = await DatabricksBackend.create({ profile: "my-workspace" });
const { url } = await startProxyServer(backend, { host: "127.0.0.1", port: 4000 });
```

## Why not LiteLLM or Portkey

Both are excellent general gateways but miss a piece this package needs:

- **LiteLLM** has the strongest Databricks auth (it can defer to the
  Databricks SDK for OAuth refresh), but it is Python - a separate
  runtime to install and supervise next to this Bun/TypeScript toolkit.
- **Portkey's** gateway is TypeScript and now has a Databricks provider,
  but it authenticates with a static personal access token (no OAuth
  refresh) and has no notion of the toolkit's fuzzy endpoint resolution.

Since Databricks is already OpenAI-compatible, the only real work is
auth and name resolution - both of which already exist off the shelf
here (the Databricks SDK and `@dbx-tools/model`). This package is the
thin glue between them, not a re-implementation of a gateway.
