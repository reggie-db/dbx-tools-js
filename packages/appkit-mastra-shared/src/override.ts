/**
 * Per-request model-override wire convention shared by the Mastra
 * plugin server (`@dbx-tools/appkit-mastra`'s `extractModelOverride`)
 * and the browser chat client (`@dbx-tools/appkit-mastra-ui`). Kept
 * here so the header / query / body field names can never drift
 * between the side that sets them and the side that reads them.
 */

/** HTTP header inspected for a per-request model override. */
export const MODEL_OVERRIDE_HEADER = "x-mastra-model";

/** Query string parameter inspected for a per-request model override. */
export const MODEL_OVERRIDE_QUERY = "model";

/** Body fields (in priority order) inspected for a per-request model override. */
export const MODEL_OVERRIDE_BODY_FIELDS = ["model", "modelId"] as const;
