/**
 * Per-request resolution of the OBO workspace client and the memory
 * scope (the user id memories are partitioned by). Shared by the
 * managed-memory tools and the recall processor so the "who is this
 * turn for, and as whom do we call Databricks" logic lives in one
 * place.
 *
 * Scope is always derived from trusted server state - the AppKit user
 * stamped on the request context, or the active execution context - and
 * never from anything the model controls. Returns `null` when there is
 * no resolvable user (a stateless turn, or an MCP call with no request
 * context), so callers cleanly no-op instead of leaking memories across
 * users.
 */

import { getExecutionContext } from "@databricks/appkit";
import { stringUtils, type appkitUtils } from "@dbx-tools/shared";
import type { RequestContext } from "@mastra/core/request-context";
import { MASTRA_RESOURCE_ID_KEY } from "@mastra/core/request-context";

import { MASTRA_USER_KEY, type User } from "../../config.js";

/** Resolved per-request memory context: the client to call and the scope. */
export interface MemoryRequestContext {
  client: appkitUtils.WorkspaceClientLike;
  scope: string;
}

/**
 * Resolve the OBO-scoped workspace client and the memory scope for the
 * current turn. Mirrors `model.ts`: prefer the AppKit user stamped on
 * the request context, fall back to the ambient execution context (the
 * active OBO scope or the service principal). Scope is the Mastra
 * resource id (the per-user thread owner) when present, else the user
 * id. Returns `null` when neither yields a usable scope.
 */
export function resolveMemoryContext(
  requestContext: RequestContext | undefined,
): MemoryRequestContext | null {
  const user = requestContext?.get(MASTRA_USER_KEY) as User | undefined;
  let executionContext: appkitUtils.ExecutionContextLike;
  try {
    executionContext = user?.executionContext ?? getExecutionContext();
  } catch {
    // No active execution context (e.g. an MCP call outside a request
    // scope). Without a client there is nothing to call.
    return null;
  }
  const resourceId = requestContext?.get(MASTRA_RESOURCE_ID_KEY) as string | undefined;
  const scope = stringUtils.trimToNull(resourceId) ?? stringUtils.trimToNull(user?.id);
  if (!scope) return null;
  return { client: executionContext.client, scope };
}
