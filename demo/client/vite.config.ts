import { appkitUiVitePlugins } from "@dbx-tools/appkit-ui/vite";
import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  plugins: appkitUiVitePlugins(),
  server: {
    middlewareMode: true,
  },
  build: {
    outDir: path.resolve(__dirname, "./dist"),
    emptyOutDir: true,
  },
  resolve: {
    conditions: ["source", "module", "browser", "default"],
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
