import {
  lakebase,
  Plugin,
  toPlugin,
  type IAppRouter,
  type PluginManifest,
} from "@databricks/appkit";

// appkit-memory persists into a Lakebase Postgres branch via the lakebase
// plugin's `pg.Pool`, so its resource requirements are identical. Forward
// lakebase's `resources.required` verbatim instead of duplicating the
// postgres / branch / database field declarations and risking drift when
// lakebase ships a new field (e.g. a new env var for a managed setting).
//
// `lakebase()` is `toPlugin(LakebasePlugin)` and just returns the
// `{ plugin, config, name }` tuple - it doesn't instantiate the plugin,
// so reading `.plugin.manifest` at module-load time is side-effect free.
// We use this instead of `getPluginManifest(lakebase().plugin)` (also
// exported from appkit) because we want the raw declared shape, not the
// post-validation normalized form.
const manifest: PluginManifest<"appkit-memory"> = {
  name: "appkit-memory",
  displayName: "Appkit Memory",
  description: "",
  stability: "beta",
  resources: {
    required: lakebase().plugin.manifest.resources.required,
    optional: [],
  },
};

export class AppkitMemory extends Plugin {
  static manifest = manifest;

  injectRoutes(router: IAppRouter): void {
    // Add your routes here, e.g.:
    // this.route(router, {
    //   name: "example",
    //   method: "get",
    //   path: "/",
    //   handler: async (_req, res) => {
    //     res.json({ message: "Hello from appkit-memory" });
    //   },
    // });
  }
}

export const appkitMemory = toPlugin(AppkitMemory);
