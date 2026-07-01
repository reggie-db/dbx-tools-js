/**
 * Per-request thread-selection wire convention shared by the Mastra
 * plugin server (`@dbx-tools/appkit-mastra`'s thread-id resolver) and
 * the browser chat client (`@dbx-tools/appkit-mastra-ui`).
 *
 * A chat client owns multiple conversations ("threads") for the same
 * resource (the authenticated user). It names the thread a given
 * request targets by stamping its id here; the server reads it back
 * and pins `RequestContext`'s thread id to that value (falling back to
 * the per-session cookie when absent). Keeping the header / query
 * names in one place means the side that sets them and the side that
 * reads them can never drift.
 */

/** HTTP header inspected for the thread id a request targets. */
export const THREAD_ID_HEADER = "x-mastra-thread-id";

/** Query string parameter inspected for the thread id a request targets. */
export const THREAD_ID_QUERY = "threadId";
