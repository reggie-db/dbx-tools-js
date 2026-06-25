/**
 * Databricks backend for the local model proxy.
 *
 * Wraps a single default-auth {@link WorkspaceClient} and exposes the
 * three things the proxy server needs: the workspace serving-endpoint
 * list, fuzzy name resolution (reusing `@dbx-tools/model`'s resolver so
 * a loose `"claude sonnet"` snaps to a real endpoint id), and a fresh
 * set of auth headers per upstream request.
 *
 * Auth is delegated entirely to the Databricks SDK: `config.authenticate`
 * re-runs the configured credential provider on every call and refreshes
 * the underlying OAuth / PAT token when it is close to expiry, so the
 * proxy never manages token lifetimes itself - each request is signed
 * with a currently-valid bearer token.
 *
 * The endpoint catalogue is listed once and reused for the process, and
 * re-listed on a resolve miss so a model deployed after start-up still
 * resolves on first use - no cache layer, just one lazy load.
 */

import { WorkspaceClient } from "@databricks/sdk-experimental";
import {
  listServingEndpointsUncached,
  resolveModelId,
  type ResolvedModel,
  type ServingEndpointSummary,
} from "@dbx-tools/model";
import { logUtils } from "@dbx-tools/shared";

import { INVOCATIONS_SUFFIX } from "./defaults.js";

const log = logUtils.logger("model-proxy/backend");

/** Options for {@link DatabricksBackend.create}. */
export interface BackendOptions {
  /** Databricks config profile (`~/.databrickscfg`). Defaults to SDK auth resolution. */
  profile?: string;
  /** Override the workspace host; otherwise resolved from SDK auth (env / profile). */
  host?: string;
  /** Fuse.js fuzzy threshold (0 = exact, 1 = anything). Defaults to the model package default. */
  threshold?: number;
}

export class DatabricksBackend {
  private readonly client: WorkspaceClient;
  /** Resolved workspace host, e.g. `https://my-workspace.cloud.databricks.com/`. */
  readonly host: string;
  private readonly threshold: number | undefined;
  /** Lazily loaded endpoint catalogue, reused for the process lifetime. */
  private endpoints: ServingEndpointSummary[] | undefined;

  private constructor(
    client: WorkspaceClient,
    host: string,
    threshold: number | undefined,
  ) {
    this.client = client;
    this.host = host;
    this.threshold = threshold;
  }

  /**
   * Build a backend: construct a default-auth workspace client (optionally
   * pinned to a profile / host) and resolve the workspace host once, so a
   * bad profile fails at start-up rather than on the first proxied request.
   */
  static async create(options: BackendOptions = {}): Promise<DatabricksBackend> {
    const client = new WorkspaceClient({
      ...(options.host ? { host: options.host } : {}),
      ...(options.profile ? { profile: options.profile } : {}),
    });
    const host = (await client.config.getHost()).toString();
    log.info("connected", { host });
    return new DatabricksBackend(client, host, options.threshold);
  }

  /**
   * The workspace's serving-endpoint catalogue, as the minimal
   * {@link ServingEndpointSummary} the resolver needs. Loaded lazily and
   * reused; pass `force` to re-list (used by `/v1/models` and the
   * resolve-on-miss path).
   */
  async models(force = false): Promise<ServingEndpointSummary[]> {
    if (this.endpoints && !force) return this.endpoints;
    const out = await listServingEndpointsUncached(this.client);
    this.endpoints = out;
    log.debug("listed endpoints", { count: out.length });
    return out;
  }

  /**
   * Snap a (possibly loose) OpenAI-style model name to the closest real
   * serving endpoint. On a miss the catalogue is re-listed once and
   * retried, so a freshly deployed model resolves without a restart.
   * Returns the input unchanged with `matched: false` when nothing scores
   * within the threshold, so a deliberate endpoint id is never silently
   * rewritten and Databricks surfaces a clean 404.
   */
  async resolve(model: string): Promise<ResolvedModel> {
    const options = this.threshold !== undefined ? { threshold: this.threshold } : {};
    let resolved = resolveModelId(model, await this.models(), options);
    if (!resolved.matched) {
      resolved = resolveModelId(model, await this.models(true), options);
    }
    return resolved;
  }

  /**
   * Mint auth headers for one upstream request. The SDK refreshes the
   * underlying token when needed, so every call gets a valid
   * `Authorization` header without the proxy tracking expiry.
   */
  async authHeaders(): Promise<Record<string, string>> {
    const headers = new Headers();
    await this.client.config.authenticate(headers);
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }

  /** OpenAI-compatible invocations URL for a resolved endpoint id. */
  invocationsUrl(endpoint: string): string {
    return new URL(
      `serving-endpoints/${encodeURIComponent(endpoint)}/${INVOCATIONS_SUFFIX}`,
      this.host,
    ).toString();
  }
}
