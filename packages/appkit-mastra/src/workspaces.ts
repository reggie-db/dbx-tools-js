/**
 * Mastra workspace factory for Databricks Apps.
 *
 * Builds a per-request {@link Workspace} whose filesystem is a
 * {@link CompositeFilesystem} over Databricks paths resolved from the
 * OBO client on {@link MASTRA_USER_KEY}. Optional mount resolver
 * contributions merge extra filesystems and skill scan roots; built-in
 * Assistant skill trees are toggled with `assistantSkills` (on by default).
 */

import type { WorkspaceClient } from "@databricks/sdk-experimental";
import type { RequestContext } from "@mastra/core/request-context";
import {
  CompositeFilesystem,
  Workspace,
  type SkillsContext,
  type SkillsResolver,
  type WorkspaceFilesystem,
} from "@mastra/core/workspace";
import { stringUtils, tokenUtils } from "@dbx-tools/shared";

import {
  MASTRA_SCOPES_KEY,
  MASTRA_USER_EMAIL_KEY,
  MASTRA_USER_KEY,
  type User,
} from "./config.js";
import { DatabricksWorkspaceFilesystem, emptyFilesystem } from "./filesystems.js";

/* ------------------------------ constants ------------------------------ */

/** Shared Assistant skills tree in the workspace namespace. */
const ASSISTANT_SHARED_SKILLS_PATH = "/Workspace/.assistant/skills";

/** Composite mount for {@link ASSISTANT_SHARED_SKILLS_PATH}. */
const ASSISTANT_WORKSPACE_SKILLS_MOUNT = "/workspace_skills";

/** Composite mount for the caller's `/.assistant/skills` tree. */
const ASSISTANT_USER_SKILLS_MOUNT = "/workspace_user_skills";

/** OAuth scopes that gate Databricks workspace file mounts. */
const WORKSPACE_FILE_SCOPES = ["workspace", "all-apis"] as const;

/* -------------------------------- types -------------------------------- */

/** Per-request context for mount resolvers. */
interface WorkspaceMountContext {
  requestContext?: RequestContext;
}

/** Mount map plus optional Mastra skill scan roots for one resolver. */
interface WorkspaceMountContribution {
  mounts: Record<string, WorkspaceFilesystem>;
  /** Paths within the composite namespace where `SKILL.md` files are scanned. */
  skillPaths?: string[];
}

/** Contributes filesystem mounts (and optional skill paths) for one request. */
type WorkspaceMountResolver = (
  context: WorkspaceMountContext,
) => WorkspaceMountContribution | Promise<WorkspaceMountContribution>;

/** Options for {@link createWorkspace}. */
interface CreateWorkspaceOptions {
  /** Workspace id; derived from `name` or `"workspace"` when omitted. */
  id?: string;
  /** Display name; derived from `id` when omitted. */
  name?: string;
  /**
   * Mount read-only Assistant skill trees from `/Workspace/.assistant/skills`
   * and `/Users/<email>/.assistant/skills`. Defaults to `true`.
   */
  assistantSkills?: boolean;
  /** Extra per-request mount resolvers (run after built-in options). */
  mounts?: WorkspaceMountResolver[];
  /** Replace the auto-built dynamic skills resolver. */
  skills?: SkillsResolver;
  /** Forwarded to Mastra when skill discovery is enabled. */
  checkSkillFileMtime?: boolean;
  /** Enable BM25 keyword search over indexed workspace content. */
  bm25?: boolean;
}

/**
 * Create a Mastra {@link Workspace} with per-request Databricks mounts.
 *
 * @example Assistant skills only (default for agents in this plugin)
 * ```ts
 * createWorkspace()
 * ```
 *
 * @example Assistant skills plus a custom mount resolver
 * ```ts
 * createWorkspace({
 *   assistantSkills: true,
 *   mounts: [
 *     async ({ requestContext }) => ({
 *       mounts: { "/data": myFilesystem },
 *       skillPaths: [],
 *     }),
 *   ],
 * })
 * ```
 */
export function createWorkspace(options: CreateWorkspaceOptions = {}): Workspace {
  const { id, name } = resolveWorkspaceIdentity(options);
  const resolvers = buildMountResolvers(options);
  const skills =
    options.skills ??
    (resolvers.length > 0 ? buildWorkspaceSkillsResolver(resolvers) : undefined);

  return new Workspace({
    id,
    name,
    filesystem: (context) => resolveWorkspaceFilesystem(resolvers, context),
    ...(skills
      ? {
          skills,
          checkSkillFileMtime:
            options.checkSkillFileMtime ?? options.assistantSkills !== false,
        }
      : {}),
    ...(options.bm25 !== false ? { bm25: true } : {}),
  });
}

/* ---------------------------- private helpers ---------------------------- */

/**
 * Map an OBO user email to their Assistant skills directory in the
 * workspace namespace.
 */
function userAssistantSkillsPath(userEmail: string): string {
  return `/Users/${userEmail.trim()}/.assistant/skills`;
}

/**
 * Return whether the request token carries a scope that allows workspace
 * file API access (`workspace` or `all-apis` on {@link MASTRA_SCOPES_KEY}).
 */
function hasWorkspaceFileScope(
  requestContext: RequestContext | undefined,
): boolean {
  return tokenUtils.includesAccessTokenScope(
    requestContext?.get(MASTRA_SCOPES_KEY),
    WORKSPACE_FILE_SCOPES,
  );
}

/**
 * Built-in mount resolver for Assistant `SKILL.md` trees.
 *
 * Mounts {@link ASSISTANT_SHARED_SKILLS_PATH} when scope checks pass and
 * `/Users/<email>/.assistant/skills` when {@link MASTRA_USER_EMAIL_KEY} is
 * set. Returns empty mounts when the OBO user or client is missing.
 * Mastra owns filesystem initialization.
 */
function resolveAssistantSkillsMounts(
  context: WorkspaceMountContext,
): WorkspaceMountContribution {
  const mounts: Record<string, DatabricksWorkspaceFilesystem> = {};
  const requestContext = context.requestContext;

  if (!shouldMountAssistantSkills(requestContext)) {
    return { mounts, skillPaths: [] };
  }

  const user = requestContext!.get(MASTRA_USER_KEY) as User | undefined;
  const client = user?.executionContext.client;
  if (!client) {
    return { mounts, skillPaths: [] };
  }

  mounts[ASSISTANT_WORKSPACE_SKILLS_MOUNT] = readOnlyDatabricksFilesystem(
    client,
    ASSISTANT_SHARED_SKILLS_PATH,
  );

  const email = resolveScopedEmail(requestContext);
  if (email) {
    mounts[ASSISTANT_USER_SKILLS_MOUNT] = readOnlyDatabricksFilesystem(
      client,
      userAssistantSkillsPath(email),
    );
  }

  return { mounts, skillPaths: Object.keys(mounts) };
}

/**
 * Fill in `id` and `name` when either is omitted on {@link CreateWorkspaceOptions}.
 * Slugifies `name` into `id`; tokenizes `id` into a display `name`.
 */
function resolveWorkspaceIdentity(options: CreateWorkspaceOptions): {
  id: string;
  name: string;
} {
  let id = options.id;
  let name = options.name;
  if (!id) {
    id = name ? stringUtils.toSlug(name) : "workspace";
  }
  if (!name) {
    name = Array.from(stringUtils.tokenize(id)).join(" ");
  }
  return { id, name };
}

/** Collect built-in and caller-supplied mount resolvers for one workspace. */
function buildMountResolvers(
  options: CreateWorkspaceOptions,
): WorkspaceMountResolver[] {
  const resolvers: WorkspaceMountResolver[] = [];
  const { assistantSkills = true, mounts } = options;
  if (assistantSkills) {
    resolvers.push(resolveAssistantSkillsMounts);
  }
  if (mounts?.length) {
    resolvers.push(...mounts);
  }
  return resolvers;
}

/**
 * Gate Assistant skill mounts on request context.
 *
 * Always allows mounts in development; in other environments requires
 * {@link hasWorkspaceFileScope}.
 */
function shouldMountAssistantSkills(
  requestContext: RequestContext | undefined,
): requestContext is RequestContext {
  if (!requestContext) return false;
  if (process.env.NODE_ENV === "development") return true;
  return hasWorkspaceFileScope(requestContext);
}

/** Read the trimmed OBO user email stamped on {@link MASTRA_USER_EMAIL_KEY}. */
function resolveScopedEmail(
  requestContext: RequestContext | undefined,
): string | undefined {
  const email = requestContext?.get(MASTRA_USER_EMAIL_KEY) as string | undefined;
  return email?.trim() || undefined;
}

/** Construct a read-only {@link DatabricksWorkspaceFilesystem} for `basePath`. */
function readOnlyDatabricksFilesystem(
  client: WorkspaceClient,
  basePath: string,
): DatabricksWorkspaceFilesystem {
  return new DatabricksWorkspaceFilesystem({
    client,
    basePath,
    readOnly: true,
  });
}

/**
 * Run every mount resolver for one request and merge mounts plus skill paths.
 * Later resolvers overwrite mount keys from earlier ones.
 */
async function resolveWorkspaceContribution(
  resolvers: WorkspaceMountResolver[],
  context: WorkspaceMountContext,
): Promise<WorkspaceMountContribution> {
  const mounts: Record<string, WorkspaceFilesystem> = {};
  const skillPaths: string[] = [];

  for (const resolver of resolvers) {
    const contribution = await resolver(context);
    Object.assign(mounts, contribution.mounts);
    if (contribution.skillPaths?.length) {
      skillPaths.push(...contribution.skillPaths);
    }
  }

  return { mounts, skillPaths };
}

/**
 * Dynamic filesystem resolver passed to Mastra {@link Workspace}.
 *
 * Returns a {@link CompositeFilesystem} when any mount resolved; otherwise
 * {@link emptyFilesystem}.
 */
async function resolveWorkspaceFilesystem(
  resolvers: WorkspaceMountResolver[],
  context: WorkspaceMountContext,
): Promise<WorkspaceFilesystem> {
  const { mounts } = await resolveWorkspaceContribution(resolvers, context);
  if (Object.keys(mounts).length === 0) return emptyFilesystem();
  return new CompositeFilesystem({ mounts });
}

/**
 * Build the dynamic {@link SkillsResolver} that collects `skillPaths` from
 * every mount resolver on each request.
 */
function buildWorkspaceSkillsResolver(
  resolvers: WorkspaceMountResolver[],
): SkillsResolver {
  return async (context: SkillsContext) => {
    const { skillPaths } = await resolveWorkspaceContribution(resolvers, context);
    return skillPaths ?? [];
  };
}
