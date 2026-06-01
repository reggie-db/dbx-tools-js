import { MastraClient } from "@mastra/client-js";
import { usePluginClientConfig } from "@databricks/appkit-ui/react";
import { chatUrl, type MastraClientConfig } from "@dbx-tools/appkit-mastra/client";

/**
 * Read the Mastra plugin's `clientConfig()` payload (mount paths,
 * default agent, registered agent list). One call per render; values
 * are cached at boot by `usePluginClientConfig`.
 */
export const useMastraConfig = (): MastraClientConfig =>
  usePluginClientConfig<MastraClientConfig>("mastra");

/**
 * Build a `MastraClient` from the published `basePath`. Using the
 * server-published value means the client keeps working even if the
 * plugin is remounted under a custom name.
 */
export const useMastraClient = (): MastraClient => {
  const { basePath } = useMastraConfig();
  return new MastraClient({
    apiPrefix: basePath,
    baseUrl: typeof window !== "undefined" ? window.location.origin : "http://localhost",
  });
};

/** Convenience: the `chatRoute` URL for an agent (defaults to the registered default). */
export const useChatUrl = (agentId?: string): string => {
  const config = useMastraConfig();
  return chatUrl(config, agentId);
};
