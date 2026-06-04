/**
 * AppKit plugin facade over the {@link ./serve.ts} Phoenix daemon
 * manager. Owns the AppKit-side concerns only:
 *
 * - The {@link manifest} that registers the plugin under `phoenix`.
 * - `setup()`: kick off (or reuse) the daemon, publish env vars for
 *   any in-process OTel SDK, install the SIGINT/SIGHUP shutdown hooks.
 * - `exports()`: surface the connection info (ports, OTLP URLs, log
 *   file) so sibling plugins like `@dbx-tools/appkit-mastra` can
 *   stream traces to Phoenix without re-spawning anything.
 *
 * All process spawning, state, lock, and signal logic lives in
 * `./serve.ts` so this file stays focused on plugin wiring.
 */

import {
  Plugin,
  toPlugin,
  type BasePluginConfig,
  type IAppRouter,
  type PluginManifest,
} from "@databricks/appkit";
import { commonUtils, logUtils } from "@dbx-tools/appkit-shared";
import type { RequestHandler } from "express";
import { proxyTo } from "./proxy.js";
import {
  installShutdownHooks,
  startPhoenix,
  stopPhoenix,
  type PhoenixContext,
} from "./serve.js";

/**
 * Toggle for the local Phoenix daemon.
 *
 * - `true` - always start (or reuse) the daemon.
 * - `false` - skip everything; the plugin registers but does
 *   nothing. Mounts no routes, exports no endpoint, publishes no
 *   env vars. Sibling plugins that look us up structurally (the
 *   mastra observability wiring) gracefully fall back to off.
 * - `"auto"` (default) - enable iff the process is **not** running
 *   inside a deployed Databricks App. Local dev gets traces; the
 *   deployed app skips the daemon because the app sandbox doesn't
 *   have `uv` / port-binding privileges and Phoenix would just
 *   crash-loop in the background.
 */
export type PhoenixEnabled = boolean | "auto";

export interface PhoenixPluginConfig extends BasePluginConfig {
  enabled?: PhoenixEnabled;
}

const manifest: PluginManifest<"phoenix"> = {
  name: "phoenix",
  displayName: "Phoenix",
  description: "Runs a local Arize Phoenix server as a restart-surviving daemon",
  stability: "beta",
  resources: {
    required: [],
    optional: [],
  },
};

export class PhoenixPlugin extends Plugin<PhoenixPluginConfig> {
  static manifest = manifest;

  private log = logUtils.logger(import.meta.url);
  private context_: PhoenixContext | null = null;
  /**
   * Resolved at `setup()`. Cached so `injectRoutes()` and
   * `exports()` agree with the decision `setup()` made without
   * re-evaluating the env (which could drift mid-process, e.g. a
   * test that mutates `DATABRICKS_APP_NAME`).
   */
  private enabled_ = false;
  /**
   * `http-proxy-middleware` registers server-level `close` and
   * `upgrade` listeners on each construction, so the middleware
   * MUST be built once and reused. Building it per-request leaks
   * listeners (`MaxListenersExceededWarning` after ~10 requests).
   */
  private proxy_: RequestHandler | null = null;

  override async setup(): Promise<void> {
    this.enabled_ = resolveEnabled(this.config.enabled);
    if (!this.enabled_) {
      this.log.info("Phoenix disabled", {
        configured: this.config.enabled ?? "auto",
        reason:
          this.config.enabled === false
            ? "explicit"
            : "auto-off (running inside a Databricks App)",
      });
      return;
    }
    // Boot the daemon with `PHOENIX_HOST_ROOT_PATH` matching this
    // plugin's AppKit mount so the proxied UI's `<base href>` and
    // asset URLs line up. The daemon respawns automatically if the
    // prefix changed since the last run.
    this.context_ = await startPhoenix({ pathPrefix: this.mountPath() });
    this.proxy_ = proxyTo({ host: "127.0.0.1", port: this.context_.httpPort });
    publishEnv(this.context_);
    installShutdownHooks();
    this.log.info("Phoenix ready", {
      mountPath: this.mountPath(),
      httpPort: this.context_.httpPort,
      grpcPort: this.context_.grpcPort,
      reused: this.context_.reused,
      logFile: this.context_.logFile,
    });
  }

  /**
   * Mount the Phoenix UI at the plugin's own AppKit prefix (so
   * `GET /api/phoenix/` returns the Phoenix landing page, asset
   * URLs resolve, GraphQL POSTs reach the daemon, etc.). The
   * upstream port lives in `this.context_` which was hydrated from
   * the state file written by `serve.ts`.
   *
   * When the plugin is disabled (explicitly or via auto-off in a
   * Databricks App) we don't register anything - the mount path
   * stays free for the host app's own catch-all / frontend
   * handler. Visitors get the host's normal 404 instead of any
   * phoenix-shaped response.
   */
  override injectRoutes(router: IAppRouter): void {
    if (!this.enabled_) return;

    // Browsers hitting the bare prefix (`GET /api/phoenix`) need
    // to land on `/api/phoenix/` so Phoenix's relative asset URLs
    // resolve. A 308 keeps the method/body intact for the rare
    // POST that omits the slash.
    router.get("/", (req, res, next) => {
      const original = req.originalUrl || req.url || "/";
      if (original.endsWith("/")) return next();
      res.redirect(308, `${original}/`);
    });

    router.use("/", (req, res, next) => {
      if (!this.proxy_) {
        // Pre-setup() request. AppKit shouldn't dispatch routes
        // before `setup()` resolves, but guard anyway so a misbehaving
        // caller gets a clean 503 instead of an undefined deref.
        res.status(503).type("text/plain").end("phoenix: not ready");
        return;
      }
      return this.proxy_(req, res, next);
    });
  }

  /**
   * Whether the daemon is running this process. Sibling plugins
   * (e.g. the mastra observability wiring) can branch on this if
   * they want to log differently when phoenix is intentionally off
   * vs. simply not registered.
   */
  isEnabled(): boolean {
    return this.enabled_;
  }

  override exports() {
    return {
      enabled: (): boolean => this.enabled_,
      get: (): PhoenixContext | null => this.context_,
      httpPort: (): number | undefined => this.context_?.httpPort,
      grpcPort: (): number | undefined => this.context_?.grpcPort,
      collectorEndpoint: (): string | undefined => this.context_?.collectorEndpoint,
      grpcEndpoint: (): string | undefined => this.context_?.grpcEndpoint,
      logFile: (): string | undefined => this.context_?.logFile,
      /**
       * Kill the daemon and remove the state file. Intended for
       * tests or a manual teardown command. The normal "stop dev
       * server" flow goes through the SIGINT handler instead.
       */
      stop: (): void => {
        stopPhoenix();
        this.context_ = null;
        this.proxy_ = null;
      },
    };
  }

  /**
   * AppKit mounts every plugin at `/api/<registered-name>`. The
   * registered name lives on `this.name` (set by `toPlugin` /
   * `createApp`); we use it instead of the manifest name so a
   * caller that renames the plugin via `phoenix({ name: "..." })`
   * still gets a matching prefix.
   */
  private mountPath(): string {
    return `/api/${this.name}`;
  }
}

export const phoenix = toPlugin(PhoenixPlugin);

/**
 * Surface the collector URL through env vars so any agent framework
 * / OTel SDK in the same process picks it up automatically. Mastra's
 * `OtelExporter` with `provider.custom.endpoint` is the explicit
 * path; this is a belt-and-suspenders fallback for libraries that
 * read the OTEL spec env vars directly.
 */
function publishEnv(ctx: PhoenixContext): void {
  process.env.PHOENIX_ENDPOINT = ctx.collectorEndpoint;
  process.env.PHOENIX_COLLECTOR_ENDPOINT = ctx.collectorEndpoint;
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = ctx.collectorEndpoint;
}

/**
 * Collapse {@link PhoenixEnabled} into a concrete boolean.
 *
 * `"auto"` defers to {@link commonUtils.isDatabricksAppEnv}: when
 * the process looks like a deployed Databricks App, the daemon
 * stays off (no `uv`, sandboxed ports, single-port serving model).
 * Anywhere else - laptop dev, CI, a self-hosted box - it boots.
 */
function resolveEnabled(configured: PhoenixEnabled | undefined): boolean {
  const value = configured ?? "auto";
  if (value === "auto") return !commonUtils.isDatabricksAppEnv();
  return value;
}
