/**
 * Databricks Statement Execution helpers for the Mastra plugin.
 *
 * Wraps `client.statementExecution.getStatement` with the shape
 * + size + error handling the plugin's tools and the
 * `/embed/data/:id` route both need:
 *
 *   - {@link fetchStatementData}: low-level fetch that returns the
 *     raw `{columns, rows, rowCount}` shape used by the
 *     `get_statement` tool's output, the `prepare_chart` tool's
 *     dataset resolver, and the route's response body. Coerces
 *     numeric strings to numbers so downstream charts /
 *     aggregations don't have to.
 *   - {@link STATEMENT_ROW_CAP}: hard cap callers (notably the
 *     `/embed/data/:id` route) clamp `limit` to so a
 *     runaway result set can't hose a response.
 *   - {@link isStatementNotFoundError}: structural detector that
 *     normalizes the SDK's two error classes plus the loose
 *     `does not exist` / `not found` message shapes into a single
 *     boolean - lets the route map upstream 404s to a clean
 *     HTTP 404 without coupling to SDK error-class identity.
 *
 * Not Genie-specific: a Databricks `statement_id` is workspace
 * scoped and lives in the Statement Execution API regardless of
 * which producer (Genie, a tool, a notebook, etc.) submitted the
 * query. Co-located here so consumers can fetch / cap / handle
 * 404s without reaching into the Genie tool module.
 */

import { ApiError, HttpError, WorkspaceClient } from "@databricks/sdk-experimental";
import type { GenieDatasetData } from "@dbx-tools/appkit-mastra-shared";
import { apiUtils } from "@dbx-tools/shared";

/**
 * Hard server-side cap on rows returned by the
 * `/embed/data/:id` route. Sized to keep responses small
 * enough for inline tables to render snappily; the route surfaces
 * a `truncated` flag whenever the upstream `rowCount` exceeds
 * this so end users know they're seeing a sample.
 */
export const STATEMENT_ROW_CAP = 500;

/**
 * Best-effort numeric coercion for the Statement Execution API's
 * all-strings cells. Leaves non-numeric strings (and explicit
 * `null`s) intact; everything else flows through `Number`.
 */
function coerceCell(cell: string | null): unknown {
  if (cell === null) return null;
  if (/^-?\d+(\.\d+)?$/.test(cell)) {
    const n = Number(cell);
    if (Number.isFinite(n)) return n;
  }
  return cell;
}

/**
 * Fetch a single statement's rows via the Statement Execution API
 * and reshape into the shared {@link GenieDatasetData} shape
 * (column array + row records).
 *
 * Optional `limit` slices the returned `rows` client-side so the
 * agent can scan a small sample without paging the full result
 * set into context. `rowCount` always reflects the upstream total
 * so callers know when the slice truncated.
 *
 * Exported because every consumer in the plugin (the
 * `get_statement` tool, the `prepare_chart` dataset resolver, and
 * the `/embed/data/:id` route) needs the exact same
 * fetch + coercion pipeline so LLM-side `get_statement` output
 * and UI-side `[data:<id>]` rendering stay shape-identical for
 * the same `statement_id`.
 */
export async function fetchStatementData(
  client: WorkspaceClient,
  statementId: string,
  options?: { limit?: number; signal?: AbortSignal },
): Promise<GenieDatasetData> {
  const ctx = options?.signal ? apiUtils.toContext(options.signal) : undefined;
  const r = await client.statementExecution.getStatement(
    { statement_id: statementId },
    ctx,
  );
  const columns = (r.manifest?.schema?.columns ?? []).map((c) => c.name ?? "");
  const dataArray = (r.result?.data_array ?? []) as Array<Array<string | null>>;
  const sliced =
    options?.limit !== undefined && options.limit >= 0
      ? dataArray.slice(0, options.limit)
      : dataArray;
  const rows = sliced.map((row) => {
    const obj: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      obj[col] = coerceCell(row[i] ?? null);
    });
    return obj;
  });
  return {
    columns,
    rows,
    rowCount: r.manifest?.total_row_count ?? dataArray.length,
  };
}

/**
 * True when `err` looks like the Databricks SDK's "statement not
 * found" error. Matches the typed {@link ApiError} 404 /
 * `RESOURCE_DOES_NOT_EXIST` shape first, then falls back to the
 * lower-level {@link HttpError} 404, then to a loose `does not
 * exist` / `not found` message sniff for SDK shapes we haven't
 * catalogued.
 *
 * Pulled into its own helper so callers (notably the
 * `/embed/data/:id` route) stay decoupled from SDK
 * error-class identity, and the conversion logic stays testable
 * in isolation.
 */
export function isStatementNotFoundError(err: unknown): boolean {
  if (err instanceof ApiError) {
    if (err.statusCode === 404) return true;
    if (err.errorCode === "RESOURCE_DOES_NOT_EXIST") return true;
  }
  if (err instanceof HttpError && err.code === 404) return true;
  if (err instanceof Error && /does not exist|not found/i.test(err.message)) {
    return true;
  }
  return false;
}
