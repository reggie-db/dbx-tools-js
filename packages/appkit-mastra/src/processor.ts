import type { Processor } from "@mastra/core/processors";

export class ResultProcessor implements Processor {
  id = "result-processor";

  // Tell Mastra to also route tool/data parts to this processor method
  processDataParts = true;

  async processOutputStream({ part }: { part: any }): Promise<any | null> {
    // 1. Guard clause: Ensure the chunk is a valid object
    if (!part || typeof part !== "object") {
      return part;
    }

    // 2. Filter for the targeted frame types
    const targetedTypes = ["step-finish", "finish", "tool-result", "data-tool-agent"];
    if (!targetedTypes.includes(part.type)) {
      return part; // Return unchanged to pass-through
    }

    // 3. Check for the presence of a payload object
    const payload = part.payload;
    if (!payload || typeof payload !== "object") {
      return part;
    }

    // 4. Safely delete the unwanted keys from the payload reference
    const keysToDelete = ["output", "messages", "response", "result"];
    for (const key of keysToDelete) {
      if (key in payload) {
        const value = payload[key];
        if (typeof value === "object") {
          payload[key] = {};
        } else if (Array.isArray(value)) {
          payload[key] = [];
        } else {
          delete payload[key];
        }
      }
    }

    // 5. Return the modified part object. Mastra handles re-serialization
    // for the outbound SSE client stream automatically.
    return part;
  }
}
