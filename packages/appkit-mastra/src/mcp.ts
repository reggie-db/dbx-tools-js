/**
 * Optional Mastra MCP server exposure for the AppKit Mastra plugin.
 *
 * Turns the plugin's registered agents (and, opt-in, its ambient tools)
 * into a Mastra `MCPServer` so external MCP clients - Claude Desktop,
 * Cursor, the Mastra playground, or another agent - can call them over
 * the standard MCP transports. The resulting server is handed to the
 * `Mastra` instance via `mcpServers`, which makes `@mastra/express`
 * serve the stock MCP routes under the plugin's base path; the plugin
 * never registers a bespoke MCP route of its own.
 */

import type { Agent } from "@mastra/core/agent";
import { MCPServer } from "@mastra/mcp";

import type { MastraTools } from "./agents.js";
import type { MastraMcpConfig, MastraPluginConfig } from "./config.js";

/** MCP server version advertised when the caller doesn't pin one. */
const DEFAULT_MCP_VERSION = "1.0.0";

/**
 * A built MCP server plus the request paths it answers on, relative to
 * the plugin's base path (`/api/<plugin>`).
 *
 * The paths are the **clean public aliases** (`/mcp`, `/sse`,
 * `/messages`) the plugin exposes. `@mastra/express` actually mounts the
 * transports under `/mcp/<serverId>/<transport>` off the `Mastra`
 * instance's `mcpServers`; the plugin rewrites the alias to that route
 * before dispatch (see {@link ResolvedMcp.serverId}), so a client never
 * sees the doubled `/mcp/<serverId>/mcp` segment.
 */
export interface ResolvedMcp {
  /**
   * Registry id, used in the underlying `@mastra/express` route
   * (`/mcp/<serverId>/...`) the plugin rewrites the clean alias to.
   */
  serverId: string;
  /** The Mastra MCP server to hand to `new Mastra({ mcpServers })`. */
  server: MCPServer;
  /** Streamable-HTTP transport path, relative to the plugin base path. */
  httpPath: string;
  /** SSE transport path, relative to the plugin base path. */
  ssePath: string;
  /** SSE message path, relative to the plugin base path. */
  messagePath: string;
}

/**
 * Build the plugin's MCP server, or `null` only when `config.mcp` is
 * explicitly `false`.
 *
 * Agent exposure is on by default because it's cheap: the already-
 * registered agents are wrapped as `ask_<agentId>` tools and handed to
 * `@mastra/express` (already mounted for the chat routes) - no extra
 * process, dependency, or network cost, and requests run under the same
 * OBO scope. So `undefined` (the default) and `true` both expose every
 * registered agent under a server id equal to the plugin name; only
 * `false` turns MCP off. The object form ({@link MastraMcpConfig}) tunes
 * the id / advertised metadata and can additionally expose the plugin's
 * ambient tools or a set of extra MCP-only tools. Ambient tools stay off
 * unless explicitly enabled - they assume an in-process chat turn, so
 * they aren't cheap / safe to expose to a standalone MCP client.
 */
export function buildMcpServer(opts: {
  config: MastraPluginConfig;
  pluginName: string;
  displayName: string;
  agents: Record<string, Agent>;
  ambientTools: MastraTools;
}): ResolvedMcp | null {
  const { config, pluginName, displayName, agents, ambientTools } = opts;
  if (config.mcp === false) return null;
  const settings: MastraMcpConfig = typeof config.mcp === "object" ? config.mcp : {};

  const serverId = settings.serverId ?? pluginName;
  const exposeAgents = settings.agents !== false;
  const exposeTools = settings.tools === true;

  // MCPServerConfig.tools is required, so always pass a record (empty
  // when the caller exposes only agents).
  const tools: MastraTools = {
    ...(exposeTools ? ambientTools : {}),
    ...(settings.extraTools ?? {}),
  };

  const server = new MCPServer({
    id: serverId,
    name: settings.name ?? `${displayName} MCP`,
    version: settings.version ?? DEFAULT_MCP_VERSION,
    ...(settings.description ? { description: settings.description } : {}),
    ...(exposeAgents ? { agents } : {}),
    tools,
  });

  // Advertise the clean aliases; the plugin rewrites these to the stock
  // `/mcp/<serverId>/<transport>` routes `@mastra/express` mounts.
  return {
    serverId,
    server,
    httpPath: "/mcp",
    ssePath: "/sse",
    messagePath: "/messages",
  };
}
