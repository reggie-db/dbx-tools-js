// Minimal ambient types for `juice` (no `@types/juice` is published).
// We only use the default export: inline a stylesheet found in the
// document's <style> tags into element `style` attributes.
declare module "juice" {
  interface JuiceOptions {
    applyStyleTags?: boolean;
    removeStyleTags?: boolean;
    preserveImportant?: boolean;
    preserveMediaQueries?: boolean;
    preserveFontFaces?: boolean;
    inlinePseudoElements?: boolean;
    xmlMode?: boolean;
    [option: string]: unknown;
  }
  function juice(html: string, options?: JuiceOptions): string;
  export = juice;
}
