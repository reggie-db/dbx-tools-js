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
  // Runs TypeScript's "organize imports" on every formatted file:
  // drops unused imports and sorts the rest. This is what lets
  // `bun run format` prune dead imports (plain prettier won't).
  plugins: ["prettier-plugin-organize-imports"],
};
