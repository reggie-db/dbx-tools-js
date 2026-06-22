/**
 * Shared helper for publishing events through Mastra's
 * `ctx.writer`. Centralizes the "the downstream stream may already
 * be closed, don't take the whole tool down" pattern that the
 * Genie agent and chart tool both need.
 *
 * Failures are logged at `warn` (a persistently-closed writer is
 * the most likely culprit when events go missing client-side) but
 * swallowed so a cancelled request or a client that navigated
 * away can't crash a tool mid-flight.
 */

import type { MastraWriter } from "@dbx-tools/appkit-mastra-shared";
import { commonUtils, type logUtils } from "@dbx-tools/shared";

/**
 * Best-effort `writer.write`. No-op when `writer` is undefined;
 * caught errors are logged via `log.warn("writer:error", ...)`
 * along with any caller-supplied `context` fields (e.g. a
 * `chartId` or `messageId`) so the warning is greppable per
 * resource.
 *
 * Returns when the write resolves or rejects; never throws.
 */
export async function safeWrite(
  log: logUtils.Logger,
  writer: MastraWriter | undefined,
  chunk: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  if (!writer) {
    log.debug("writer:no-writer", context);
    return;
  }
  try {
    await writer.write(chunk);
    log.debug("writer:ok", context);
  } catch (err) {
    log.warn("writer:error", {
      ...context,
      error: commonUtils.errorMessage(err),
    });
  }
}
