#!/usr/bin/env node
/**
 * `model-proxy` CLI.
 *
 * `serve` (the default) runs a loopback OpenAI-compatible endpoint that
 * fronts Databricks Model Serving with fuzzy model names and per-request
 * auth. `chat` starts that same proxy and hands off to an off-the-shelf
 * terminal client wired to it. `models` lists the resolvable endpoints;
 * `resolve` shows what a fuzzy name snaps to. Auth comes from the standard
 * Databricks SDK resolution (env vars, `--profile`, or `databricks auth
 * login`).
 */

import { Command, CommanderError } from "commander";
import { spawn } from "node:child_process";
import type { Server } from "node:http";

import { DatabricksBackend, type BackendOptions } from "./backend.js";
import { DEFAULT_BIND_HOST, DEFAULT_PORT } from "./defaults.js";
import { startProxyServer } from "./server.js";

/**
 * Default terminal client for `chat`, launched via `bunx`. OpenHarness is
 * an OpenAI-compatible TUI that reads the endpoint straight from the env
 * we inject (`LLM_PROVIDER=openai-compat` + `OPENAI_BASE_URL`), so no
 * config step is needed. Override with `--client` / `PROXY_CHAT_CLIENT`.
 */
const DEFAULT_CHAT_CLIENT = "bunx @alhazmiai/openharness";

/** Shared `--profile` / `--workspace-host` / `--threshold` flags. */
interface CommonOpts {
  profile?: string;
  workspaceHost?: string;
  threshold?: string;
}

/** Shared listen + auth flags for the proxy-starting commands. */
interface ServeOpts extends CommonOpts {
  port: string;
  host: string;
  apiKey?: string;
}

/** Map shared CLI flags onto {@link BackendOptions}. */
function backendOptions(opts: CommonOpts): BackendOptions {
  return {
    ...(opts.profile ? { profile: opts.profile } : {}),
    ...(opts.workspaceHost ? { host: opts.workspaceHost } : {}),
    ...(opts.threshold !== undefined ? { threshold: Number(opts.threshold) } : {}),
  };
}

/** Create the backend and start the proxy from the shared listen flags. */
async function startProxy(
  opts: ServeOpts,
): Promise<{ backend: DatabricksBackend; server: Server; url: string }> {
  const backend = await DatabricksBackend.create(backendOptions(opts));
  const apiKey = opts.apiKey ?? process.env.PROXY_API_KEY;
  const { server, url } = await startProxyServer(backend, {
    host: opts.host,
    port: Number(opts.port),
    ...(apiKey ? { apiKey } : {}),
  });
  return { backend, server, url };
}

const program = new Command()
  .name("model-proxy")
  .description("Local OpenAI-compatible proxy to Databricks Model Serving.");

program
  .command("serve", { isDefault: true })
  .description("Run the local OpenAI-compatible proxy.")
  .option("-p, --port <port>", "port to listen on", String(DEFAULT_PORT))
  .option("-H, --host <host>", "address to bind", DEFAULT_BIND_HOST)
  .option("--profile <profile>", "Databricks config profile")
  .option("--workspace-host <url>", "override the Databricks workspace host")
  .option("-t, --threshold <n>", "fuzzy match threshold (0..1)")
  .option("-k, --api-key <key>", "require this bearer token from local clients")
  .action(async (opts: ServeOpts) => {
    const { backend, url } = await startProxy(opts);
    process.stderr.write(`model-proxy -> ${backend.host}\n`);
    process.stderr.write(`  OpenAI base URL: ${url}/v1\n`);
  });

program
  .command("chat")
  .description("Start the proxy and launch a terminal chat client wired to it.")
  .option("-p, --port <port>", "proxy port", String(DEFAULT_PORT))
  .option("-H, --host <host>", "proxy bind host", DEFAULT_BIND_HOST)
  .option("--profile <profile>", "Databricks config profile")
  .option("--workspace-host <url>", "override the Databricks workspace host")
  .option("-t, --threshold <n>", "fuzzy match threshold (0..1)")
  .option("-m, --model <name>", "default model (fuzzy name ok)")
  .option(
    "--client <cmd>",
    "terminal chat CLI to launch (run via your shell)",
    process.env.PROXY_CHAT_CLIENT ?? DEFAULT_CHAT_CLIENT,
  )
  .action(
    async (opts: ServeOpts & { model?: string; client: string }) => {
      const { backend, server, url } = await startProxy(opts);
      const baseUrl = `${url}/v1`;
      process.stderr.write(
        `model-proxy -> ${backend.host}\n  OpenAI base URL: ${baseUrl}\n  launching: ${opts.client}\n`,
      );
      // Hand off to an off-the-shelf OpenAI-compatible client, pointing it
      // at the proxy via the standard env vars (plus the provider switches
      // a couple of popular CLIs read). `shell: true` lets `--client` carry
      // its own args, e.g. `--client "bunx merlion"`.
      const child = spawn(opts.client, {
        stdio: "inherit",
        shell: true,
        env: {
          ...process.env,
          OPENAI_BASE_URL: baseUrl,
          OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "model-proxy",
          ...(opts.model ? { OPENAI_MODEL: opts.model } : {}),
          LLM_PROVIDER: "openai-compat",
          CLAUDE_CODE_USE_OPENAI: "1",
        },
      });
      child.on("exit", (code) => {
        server.close();
        process.exit(code ?? 0);
      });
      process.on("SIGINT", () => child.kill("SIGINT"));
    },
  );

program
  .command("models")
  .description("List resolvable Databricks serving endpoints (as JSON).")
  .option("--profile <profile>", "Databricks config profile")
  .option("--workspace-host <url>", "override the Databricks workspace host")
  .action(async (opts: CommonOpts) => {
    const backend = await DatabricksBackend.create(backendOptions(opts));
    const endpoints = await backend.models();
    process.stdout.write(`${JSON.stringify(endpoints, null, 2)}\n`);
  });

program
  .command("resolve")
  .description("Show what a fuzzy model name resolves to (as JSON).")
  .argument("<query...>", "model name / fuzzy search terms")
  .option("--profile <profile>", "Databricks config profile")
  .option("--workspace-host <url>", "override the Databricks workspace host")
  .option("-t, --threshold <n>", "fuzzy match threshold (0..1)")
  .action(async (query: string[], opts: CommonOpts) => {
    const backend = await DatabricksBackend.create(backendOptions(opts));
    const resolved = await backend.resolve(query.join(" "));
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof CommanderError) process.exit(err.exitCode);
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
