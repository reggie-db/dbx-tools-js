/**
 * Default Vite plugins for host apps building `@dbx-tools/*` UI packages.
 * Import from `@dbx-tools/appkit-ui/vite` so Tailwind and React refresh
 * resolve from this package's dependencies, not the host's.
 */
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";

/** React + Tailwind v4 plugins for a standard AppKit UI Vite app. */
export function appkitUiVitePlugins() {
  return [react(), tailwindcss()];
}
