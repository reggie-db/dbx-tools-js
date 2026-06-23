/** @type {import("prettier").Config} */
export default {
  printWidth: 88,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  bracketSpacing: true,
  arrowParens: "always",
  // `prettier-plugin-organize-imports` (drops unused imports and sorts
  // the rest) is injected by `devkit format` via an absolute path
  // resolved from devkit's own install, so it isn't listed here by name
  // - a bare name wouldn't resolve when the package manager nests the
  // plugin under `packages/devkit/node_modules` instead of hoisting it.
};
