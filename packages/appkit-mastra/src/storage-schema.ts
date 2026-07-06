/**
 * Derive a Postgres-safe schema name for per-agent Mastra storage.
 *
 * Agent ids are often kebab-case route segments (`data-mesh-book-assistant`)
 * but {@link PostgresStore} validates `schemaName` with Mastra's
 * `parseSqlIdentifier` (letter/underscore start, `[A-Za-z0-9_]` only, max 63).
 */

import { stringUtils } from "@dbx-tools/shared";

const SCHEMA_PREFIX = "mastra_";
const MAX_PG_IDENTIFIER_LEN = 63;

/**
 * Default Lakebase schema for one agent's thread/message store:
 * `mastra_<sanitized-agent-id>`.
 */
export function agentStorageSchemaName(agentId: string): string {
  const maxSlugLen = MAX_PG_IDENTIFIER_LEN - SCHEMA_PREFIX.length;
  const slug = stringUtils.toIdentifierWithOptions(
    {
      delimiter: "_",
      maxLength: maxSlugLen,
      truncateStrategy: "hash",
      truncateHashLength: 6,
    },
    agentId,
  );
  const body =
    slug ||
    stringUtils.toIdentifierWithOptions(
      {
        delimiter: "_",
        maxLength: maxSlugLen,
        truncateStrategy: "hash",
        truncateHashLength: 6,
      },
      "agent",
      agentId,
    );
  return `${SCHEMA_PREFIX}${body}`;
}
