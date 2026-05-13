import {
  genie,
  lakebase,
  Plugin,
  serving,
  toPlugin,
  type BasePluginConfig,
  type IAppRouter,
  type PluginManifest,
  type ResourceRequirement,
} from "@databricks/appkit";
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { PgVector, PgVectorConfig, PostgresStore, PostgresStoreConfig } from "@mastra/pg";
import type { Pool, PoolConfig } from "pg";

// AppKit plugin that wraps the `genie` and `lakebase` plugins as a
// Mastra `Agent` factory. When `enableGenie: true`, the agent is built
// with one `genie` tool per configured space alias plus a
// `genie_get_conversation` tool. When `enableMemory: true`, the agent
// is configured with a Mastra `Memory` backed by lakebase's pool
// (PostgresStore + PgVector). Callers supply the model and instructions
// via `agent({ model, instructions, ... })`.

const _SERVING_MANIFEST = serving().plugin.manifest;
const _GENIE_MANIFEST = genie().plugin.manifest;
const _LAKEBASE_MANIFEST = lakebase().plugin.manifest;

interface LakebasePluginExports {
  pool: Pool;
  getPgConfig: () => PoolConfig;
}




type AppkitMastraMemoryConfig = PgVectorConfig & {
  id?: string;
}


interface AppkitMastraConfig extends BasePluginConfig {
  genie?: boolean;
  storage?: boolean | PostgresStoreConfig;
  memory?: boolean | AppkitMastraMemoryConfig;
}




export class AppkitMastra extends Plugin<AppkitMastraConfig> {
  static manifest = {
    name: "appkit-mastra",
    displayName: "Appkit Mastra",
    description:
      "Builds a Mastra Agent from AppKit plugins: optional Genie tool wiring " +
      "via the `genie` plugin and Postgres-backed Mastra Memory via the " +
      "`lakebase` plugin.",
    stability: "beta",
    resources: {
      required: [..._SERVING_MANIFEST.resources.required],
      optional: [
        ..._GENIE_MANIFEST.resources.required,
        ..._LAKEBASE_MANIFEST.resources.required,
      ],
    },
  } satisfies PluginManifest<"appkit-mastra">;

  /**
   * Tighten resource requirements based on which features are enabled.
   * AppKit calls this at registration time (config-aware) so disabled
   * features don't surface their resource asks to the host app.
   */
  static getResourceRequirements(
    config: AppkitMastraConfig,
  ): ResourceRequirement[] {
    const resources: ResourceRequirement[] = [];
    const enabledManifests: PluginManifest<string>[] = [];

    if (config.genie) enabledManifests.push(_GENIE_MANIFEST);
    if (!!config.storage || !!config.memory) {
      enabledManifests.push(_LAKEBASE_MANIFEST);
    }
    for (const m of enabledManifests) {
      for (const resource of m.resources.required) {
        resources.push({ ...resource, required: true } as ResourceRequirement);
      }
    }
    return resources;
  }



  private agents: Agent[] = []

  injectRoutes(_router: IAppRouter): void {
    // No HTTP surface; consumers attach routes around the agent via
    // their own Mastra integration (e.g. @mastra/server).
  }



  override async setup(): Promise<void> {
    if (!!this.config.genie || !!this.config.storage || !!this.config.memory) {
      this.context?.onLifecycle("setup:complete", () => {
        this.agents.push(...this.createAgents())
      });
    } else {
      this.agents.push(...this.createAgents())
    }

  }

  override exports() {
    return {
      getAgents: () => this.agents
    }
  }

  private createAgents(): Agent[] {
    const storage = this.pgStore()
    const vector = this.pgVector()
    const memory = new Memory({
      storage,
      vector,
    })
    const agent = new Agent({
      id: "appkit-mastra-agent",
      name: "AppKit Mastra Agent",
      instructions: "You are a helpful assistant.",
      model: "gpt-4o",
      tools: {},
      memory,
    })
    return [agent]
  }

  private pgStore(): PostgresStore | undefined {
    if (!this.config.storage) return undefined;
    const lakebaseExports = this.lakebasePluginExports()
    if (typeof this.config.storage === "boolean") {
      const pool = lakebaseExports.pool
      return new PostgresStore({
        id: "appkit-mastra-store",
        pool,
      });
    } else {
      return new PostgresStore(this.config.storage);
    }
  }

  private pgVector(): PgVector | undefined {
    if (!this.config.memory) return undefined;
    const lakebaseExports = this.lakebasePluginExports()
    if (typeof this.config.memory === "boolean") {
      const pool = lakebaseExports.pool
      const vector = new PgVector({
        id: "appkit-mastra-memory",
        ...lakebaseExports.getPgConfig(),
      });
      (vector as unknown as { pool: typeof pool }).pool = pool;
      return vector;
    } else {
      return new PgVector(this.config.memory);
    }
  }

  private lakebasePluginExports(): LakebasePluginExports {
    return this.pluginExports<LakebasePluginExports>("lakebase");
  }

  private pluginExports<T>(pluginName: string): T {
    const ctx = this.context;
    const plugin = ctx?.getPlugins().get(pluginName) as
      | Plugin
      | undefined;
    if (!plugin) {
      throw new Error(
        "required plugin not found: " + pluginName,
      );
    }
    return plugin.exports() as T;

  }

}
export const appkitMastra = toPlugin(AppkitMastra);