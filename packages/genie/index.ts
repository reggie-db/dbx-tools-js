/**
 * `@dbx-tools/genie` public surface.
 *
 * - {@link streamGenie}: async generator driving one Genie
 *   conversation turn against a caller-owned `WorkspaceClient`.
 *   Yields {@link GenieEvent}s as they arrive, returns the final
 *   `GenieMessage`, and cancels every in-flight SDK call when the
 *   caller's `AbortSignal` aborts (or the consumer breaks out of
 *   the `for await`).
 * - Wire-format types derived structurally from
 *   `@databricks/sdk-experimental` (`apis/dashboards`), widened
 *   with `thoughts[]` and `auto_regenerate_count` which Genie
 *   returns on the wire but the SDK doesn't currently type.
 * - Event protocol as a Zod-backed discriminated union
 *   (`GenieEventSchema` / `GenieEvent` / `GenieEventType` /
 *   `GenieEventOf<T>`), suitable for SSE consumers that need
 *   runtime validation on top of static narrowing.
 *
 * Browser-safe imports: only the `./src/protocol.js` types are
 * pure / runtime-free. `./src/service.js` is Node-only (depends on
 * a runtime `WorkspaceClient` from `@databricks/sdk-experimental`,
 * which itself targets Node >=22).
 */

export * from "./src/protocol.js";
export * from "./src/service.js";
