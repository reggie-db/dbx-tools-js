/**
 * `@dbx-tools/genie` space metadata helpers.
 *
 * Fetches a Genie space's definition (including the opt-in
 * `serialized_space` blob) and extracts the curated starter
 * questions an author configured on the space. The typed SDK
 * `client.genie.getSpace` only returns the directory-listing surface
 * (`title` / `description` / `warehouse_id`); the sample questions
 * live inside `serialized_space`, which the REST API returns only
 * when `include_serialized_space=true`. We hit that endpoint through
 * the workspace client's raw `apiClient` since the typed request
 * shape has no flag for it.
 */

import { WorkspaceClient } from "@databricks/sdk-experimental";
import { GenieSpaceSchema, type GenieSpace } from "@dbx-tools/genie-shared";
import { apiUtils, commonUtils, logUtils } from "@dbx-tools/shared";

const log = logUtils.logger("genie/space");

/** Options for {@link getGenieSpace}. */
export interface GetGenieSpaceOptions {
  /**
   * Explicit `WorkspaceClient`. Defaults to a fresh
   * `new WorkspaceClient({})` (env-var auth). Server callers should
   * pass their OBO-scoped client so the lookup runs as the user.
   */
  workspaceClient?: WorkspaceClient;
  /**
   * Request the `serialized_space` blob (catalogs, tables, sample
   * questions, prompts). Defaults to `true` - the only reason to
   * skip it is when the caller just needs title / description and
   * wants the smaller payload.
   */
  serialized?: boolean;
  /**
   * External cancellation. Accepts a WHATWG `AbortSignal` or a
   * fully-built SDK `Context` (see `apiUtils.ContextLike`).
   */
  context?: apiUtils.ContextLike;
}

/**
 * Fetch a Genie space by id, optionally including its serialized
 * definition. Hits `GET /api/2.0/genie/spaces/<id>` with
 * `include_serialized_space=true` through the raw `apiClient`, then
 * validates the response against {@link GenieSpaceSchema} (unknown
 * fields like `etag` / `parent_path` are stripped).
 */
export async function getGenieSpace(
  spaceId: string,
  options?: GetGenieSpaceOptions,
): Promise<GenieSpace> {
  const client = options?.workspaceClient ?? new WorkspaceClient({});
  const serialized = options?.serialized !== false;
  const context = options?.context ? apiUtils.toContext(options.context) : undefined;
  const raw = await client.apiClient.request(
    {
      path: `/api/2.0/genie/spaces/${encodeURIComponent(spaceId)}`,
      method: "GET",
      query: serialized ? { include_serialized_space: true } : {},
      headers: new Headers(),
      raw: false,
    },
    context,
  );
  return GenieSpaceSchema.parse(raw);
}

/**
 * One entry in a serialized space's `config.sample_questions`. The
 * author-facing field is `question`, which the wire format models as
 * a string array (a single multi-line question is split across
 * entries); we treat the first non-empty entry as the displayable
 * question text.
 */
interface SerializedSampleQuestion {
  question?: unknown;
}

/** Pull the first non-empty string out of a `question` field (string | string[]). */
function questionText(question: unknown): string | undefined {
  if (typeof question === "string") {
    const trimmed = question.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(question)) {
    for (const part of question) {
      if (typeof part === "string" && part.trim().length > 0) return part.trim();
    }
  }
  return undefined;
}

/**
 * Extract the curated starter questions an author configured on a
 * Genie space. Reads `serialized_space -> config.sample_questions[*]
 * .question`. Returns `[]` when the space carries no serialized blob,
 * the blob is unparseable, or no sample questions are configured -
 * so a missing or misconfigured space degrades to "no suggestions"
 * rather than throwing. Order is preserved (the author's ordering)
 * and duplicates are dropped.
 */
export function genieSampleQuestions(space: GenieSpace): string[] {
  const serialized = space.serialized_space;
  if (!serialized) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (err) {
    log.warn("serialized-space:parse-error", {
      spaceId: space.space_id,
      error: commonUtils.errorMessage(err),
    });
    return [];
  }
  const sampleQuestions = (parsed as { config?: { sample_questions?: unknown } } | null)
    ?.config?.sample_questions;
  if (!Array.isArray(sampleQuestions)) return [];

  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of sampleQuestions as SerializedSampleQuestion[]) {
    const text = questionText(entry?.question);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}
