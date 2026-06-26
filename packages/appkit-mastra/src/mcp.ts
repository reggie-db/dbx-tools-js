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
 * the plugin's base path (`/api/<plugin>`). The paths are informational
 * (logging / `exports().getMcp()`); the routes themselves are mounted
 * by `@mastra/express` off the `Mastra` instance's `mcpServers`.
 */
export interface ResolvedMcp {
  /** Registry id, used in the route path (`/mcp/<serverId>/...`). */
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
 * Build the plugin's MCP server, or `null` when `config.mcp` is falsy
 * (the default - no MCP endpoints).
 *
 * `true` exposes every registered agent as an `ask_<agentId>` MCP tool
 * under a server id equal to the plugin name. The object form
 * ({@link MastraMcpConfig}) tunes the id / advertised metadata and can
 * additionally expose the plugin's ambient tools or a set of extra
 * MCP-only tools.
 */
export function buildMcpServer(opts: {
  config: MastraPluginConfig;
  pluginName: string;
  displayName: string;
  agents: Record<string, Agent>;
  ambientTools: MastraTools;
}): ResolvedMcp | null {
  const { config, pluginName, displayName, agents, ambientTools } = opts;
  if (!config.mcp) return null;
  const settings: MastraMcpConfig = config.mcp === true ? {} : config.mcp;

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

  return {
    serverId,
    server,
    httpPath: `/mcp/${serverId}/mcp`,
    ssePath: `/mcp/${serverId}/sse`,
    messagePath: `/mcp/${serverId}/messages`,
  };
}
