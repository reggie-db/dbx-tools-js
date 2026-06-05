/**
 * AppKit plugin facade over the {@link ./serve.ts} Arize Phoenix
 * daemon manager. Owns the AppKit-side concerns only:
 *
 * - The {@link manifest} that registers the plugin under `phoenix`,
 *   so the UI proxies under `/api/phoenix/...` (matching the
 *   open-source `arize-phoenix` server's brand for the URL surface).
 * - `setup()`: kick off (or reuse) the daemon, publish env vars
 *   (`MLFLOW_TRACKING_URI`, `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, the
 *   `PHOENIX_*` family) so any in-process OTel / MLflow SDK picks up
 *   the local collector with zero coupling, and install the
 *   SIGINT/SIGHUP shutdown hooks.
 * - `injectRoutes()`: reverse-proxy the Phoenix UI under the plugin's
 *   AppKit mount.
 *
 * The integration contract is intentionally env-var-based: sibling
 * plugins should never read this plugin's exports directly. They look
 * at `MLFLOW_TRACKING_URI` / `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and
 * route traces there. That way the daemon can be swapped for any
 * other OTLP collector (Databricks-managed MLflow, an external
 * Phoenix, etc.) without touching consumers.
 *
 * Package naming convention: the npm package + factory export are
 * named `arize` (the company / org), while the URL surface uses
 * `phoenix` (the server's product name). Doc comments use whichever
 * better matches the layer being described.
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
  startArize,
  stopArize,
  type ArizeContext,
} from "./serve.js";

/**
 * Toggle for the local Arize Phoenix daemon.
 *
 * - `true` - always start (or reuse) the daemon.
 * - `false` - skip everything; the plugin registers but does
 *   nothing. Mounts no routes, publishes no env vars. Anything
 *   reading the env-var contract (`MLFLOW_TRACKING_URI`, etc.)
 *   stays untouched and gracefully falls back to "no local
 *   collector".
 * - `"auto"` (default) - enable when the process is local dev. Skip
 *   the daemon when:
 *   - `MLFLOW_TRACKING_URI` is already set in the environment
 *     (someone else owns observability and we should not clobber
 *     their endpoint), or
 *   - The process is running inside a deployed Databricks App (the
 *     sandbox lacks `uv` / port-binding privileges and the host's
 *     managed MLflow is the right target anyway).
 */
export type ArizeEnabled = boolean | "auto";

export interface ArizePluginConfig extends BasePluginConfig {
  enabled?: ArizeEnabled;
}

// Manifest `name` is `"phoenix"` so AppKit mounts the UI under
// `/api/phoenix/...`. The npm-side identity (package, factory
// export) stays `arize` for the org/brand; this split matches the
// daemon's product name (Phoenix) on the URL surface.
const manifest: PluginManifest<"phoenix"> = {
  name: "phoenix",
  displayName: "Arize Phoenix",
  description: "Runs a local Arize Phoenix server as a restart-surviving daemon",
  stability: "beta",
  resources: {
    required: [],
    optional: [],
  },
};

export class ArizePlugin extends Plugin<ArizePluginConfig> {
  static manifest = manifest;

  private log = logUtils.logger(import.meta.url);
  private context_: ArizeContext | null = null;
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
    const decision = resolveEnabled(this.config.enabled);
    this.enabled_ = decision.enabled;
    if (!this.enabled_) {
      this.log.info("Arize disabled", {
        configured: this.config.enabled ?? "auto",
        reason: decision.reason,
      });
      return;
    }
    // Boot the daemon with `PHOENIX_HOST_ROOT_PATH` matching this
    // plugin's AppKit mount so the proxied UI's `<base href>` and
    // asset URLs line up. The daemon respawns automatically if the
    // prefix changed since the last run.
    this.context_ = await startArize({ pathPrefix: this.mountPath() });
    this.proxy_ = proxyTo({ host: "127.0.0.1", port: this.context_.httpPort });
    publishEnv(this.context_);
    installShutdownHooks();
    this.log.info("Arize ready", {
      mountPath: this.mountPath(),
      httpPort: this.context_.httpPort,
      grpcPort: this.context_.grpcPort,
      reused: this.context_.reused,
      logFile: this.context_.logFile,
    });
  }

  /**
   * Mount the Arize Phoenix UI at the plugin's own AppKit prefix
   * (so `GET /api/phoenix/` returns the Phoenix landing page, asset
   * URLs resolve, GraphQL POSTs reach the daemon, etc.). The
   * upstream port lives in `this.context_` which was hydrated from
   * the state file written by `serve.ts`.
   *
   * When the plugin is disabled (explicitly or via auto-off in a
   * Databricks App) we don't register anything - the mount path
   * stays free for the host app's own catch-all / frontend
   * handler. Visitors get the host's normal 404 instead of any
   * Phoenix-shaped response.
   */
  override injectRoutes(router: IAppRouter): void {
    if (!this.enabled_) return;

    // Browsers hitting the bare prefix (`GET /api/phoenix`) need to
    // land on `/api/phoenix/` so Phoenix's relative asset URLs
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
        res.status(503).type("text/plain").end("arize: not ready");
        return;
      }
      return this.proxy_(req, res, next);
    });
  }

  /**
   * Status / teardown surface. The integration contract for sibling
   * plugins is the published env vars (see {@link publishEnv}), not
   * these exports - they exist only for tests, diagnostics, and
   * manual teardown commands.
   */
  override exports() {
    return {
      enabled: (): boolean => this.enabled_,
      /**
       * Kill the daemon and remove the state file. Intended for
       * tests or a manual teardown command. The normal "stop dev
       * server" flow goes through the SIGINT handler instead.
       */
      stop: (): void => {
        stopArize();
        this.context_ = null;
        this.proxy_ = null;
      },
    };
  }

  /**
   * AppKit mounts every plugin at `/api/<registered-name>`. The
   * registered name lives on `this.name` (set by `toPlugin` /
   * `createApp`); we use it instead of the manifest name so a
   * caller that renames the plugin via `arize({ name: "..." })`
   * still gets a matching prefix.
   */
  private mountPath(): string {
    return `/api/${this.name}`;
  }
}

export const arize = toPlugin(ArizePlugin);

/**
 * Surface the collector URL through env vars so any agent framework
 * / OTel SDK / MLflow client in the same process picks it up
 * automatically without ever importing this plugin.
 *
 * Two families are published:
 *
 * - `MLFLOW_*` - mastra's observability wiring (and any other MLflow
 *   client) keys off these. `MLFLOW_EXPERIMENT_ID` is a Phoenix-side
 *   no-op (Phoenix ignores the header) but unblocks the env-as-is
 *   short-circuit in consumers so they skip workspace lookups.
 * - `OTEL_*` / `PHOENIX_*` - generic OTLP and OSS Phoenix SDKs read
 *   these names natively.
 *
 * We never clobber an env var the user (or the host process) set
 * before this plugin booted - the gate in {@link resolveEnabled}
 * already kept us off when `MLFLOW_TRACKING_URI` was preset, but the
 * guards here are belt-and-suspenders for the explicit `enabled:
 * true` path that bypasses the gate.
 */
function publishEnv(ctx: ArizeContext): void {
  setIfUnset("MLFLOW_TRACKING_URI", ctx.collectorEndpoint);
  setIfUnset("MLFLOW_EXPERIMENT_ID", "phoenix");
  setIfUnset("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", ctx.collectorEndpoint);
  setIfUnset("PHOENIX_ENDPOINT", ctx.collectorEndpoint);
  setIfUnset("PHOENIX_COLLECTOR_ENDPOINT", ctx.collectorEndpoint);
}

function setIfUnset(key: string, value: string): void {
  if (!process.env[key]) process.env[key] = value;
}

interface EnabledDecision {
  enabled: boolean;
  reason: string;
}

/**
 * Collapse {@link ArizeEnabled} into a concrete decision plus a
 * human-readable reason for the log line.
 *
 * Explicit `true` / `false` are honored verbatim. `"auto"` (default)
 * stays off when either of these is true:
 *
 * - `MLFLOW_TRACKING_URI` is already set: the user / host already
 *   declared an OTLP target and we shouldn't run a second collector
 *   on top.
 * - {@link commonUtils.isDatabricksAppEnv}: deployed Databricks Apps
 *   don't have `uv` / port-binding privileges and the managed MLflow
 *   tracking on the workspace is the right target.
 *
 * Anywhere else - laptop dev, CI, self-hosted box - the daemon
 * boots.
 */
function resolveEnabled(configured: ArizeEnabled | undefined): EnabledDecision {
  const value = configured ?? "auto";
  if (value === true) return { enabled: true, reason: "explicit-on" };
  if (value === false) return { enabled: false, reason: "explicit-off" };
  if (process.env.MLFLOW_TRACKING_URI) {
    return { enabled: false, reason: "auto-off (MLFLOW_TRACKING_URI preset)" };
  }
  if (commonUtils.isDatabricksAppEnv()) {
    return { enabled: false, reason: "auto-off (Databricks App env)" };
  }
  return { enabled: true, reason: "auto-on" };
}
