import { serving, WorkspaceClient } from "@databricks/sdk-experimental";
import pMemoize from "p-memoize";

export const getWorkspaceClient = pMemoize(async () => {
  try {
    return new WorkspaceClient({});
  } catch (error) {
    console.error("Error creating workspace client:", error);
    return null;
  }
});

export async function aiQuery(
  prompt: string,
  ctx: any,
  model?: string,
): Promise<string | null> {
  const contentParts = [prompt];
  if (ctx) {
    contentParts.push("Context:", JSON.stringify(ctx));
  }
  const content = contentParts
    .map((part) => part?.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();

  if (!content) return null;

  const client = await getWorkspaceClient();
  if (!client) return null;

  const response = await client.servingEndpoints.query({
    name: model ?? "databricks-claude-opus-4-6",
    messages: [{ role: "user", content: content }],
  });
  return parseResponse(response);
}

function parseResponse(response: serving.QueryEndpointResponse): string | null {
  const content = response?.choices?.[0]?.message?.content;
  return content || null;
}
