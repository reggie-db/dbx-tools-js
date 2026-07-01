import { stringUtils } from "@dbx-tools/shared";
import {
  createHighlighter,
  type BundledLanguage,
  type BundledTheme,
  type Highlighter,
} from "shiki";
import type { CodeHighlighterPlugin } from "streamdown";

// Streamdown 2.x ships syntax highlighting as an opt-in plugin and has
// no shiki dependency of its own; without a `code` plugin every fenced
// block renders as uncolored plaintext. This module provides a small
// shiki-backed highlighter to wire in via `plugins={{ code }}`.

/**
 * Languages we highlight in the chat. SQL is the primary one (Genie
 * query previews); the rest cover code the assistant might emit. Kept
 * to a curated set so shiki only bundles these grammars.
 */
const LANGUAGES: BundledLanguage[] = [
  "sql",
  "python",
  "typescript",
  "javascript",
  "json",
  "bash",
  "yaml",
  "markdown",
];

/**
 * Single light theme. The demo has no dark-mode toggle, and a single
 * theme guarantees every token carries a concrete `color` (shiki's
 * dual-theme mode emits CSS-variable-only tokens that need extra CSS
 * wiring to paint).
 */
const THEME: BundledTheme = "github-light";

/** Languages we can tokenize, as a set for O(1) support checks. */
const SUPPORTED = new Set<BundledLanguage>(LANGUAGES);

let _highlighter: Highlighter | null = null;
let _loading: Promise<Highlighter> | null = null;

/** Lazily create the shared shiki highlighter (singleton, loaded once). */
function loadHighlighter(): Promise<Highlighter> {
  _loading ??= createHighlighter({ themes: [THEME], langs: LANGUAGES }).then((h) => {
    _highlighter = h;
    return h;
  });
  return _loading;
}

/** Tokenize `code` with the active theme into Streamdown's result shape. */
function highlightTokens(h: Highlighter, code: string, language: BundledLanguage) {
  const { tokens, fg, bg, rootStyle } = h.codeToTokens(code, {
    lang: language,
    theme: THEME,
  });
  return { tokens, fg, bg, rootStyle };
}

/** Escape HTML-significant characters (from the shared string utils). */
const escapeHtml = stringUtils.escapeHtml;

/**
 * Highlight `code` into minimal inline HTML: one colored `<span>` per
 * token, lines joined by real newlines, with no line-number gutter or
 * per-line wrapper elements. Meant to drop straight into a
 * `<pre><code>` so the rendered text stays cleanly selectable and
 * copyable. Falls back to plain escaped text when the language isn't
 * supported or shiki fails to parse the snippet.
 */
export async function highlightToHtml(code: string, language: string): Promise<string> {
  if (!SUPPORTED.has(language as BundledLanguage)) return escapeHtml(code);
  const h = await loadHighlighter();
  try {
    const { tokens } = h.codeToTokens(code, {
      lang: language as BundledLanguage,
      theme: THEME,
    });
    return tokens
      .map((line) =>
        line
          .map(
            (token) =>
              `<span style="color:${token.color ?? "inherit"}">${escapeHtml(token.content)}</span>`,
          )
          .join(""),
      )
      .join("\n");
  } catch {
    return escapeHtml(code);
  }
}

/**
 * shiki-backed code highlighter plugin for Streamdown. The highlighter
 * loads asynchronously: the first call for any block returns `null`
 * and resolves through the `callback` once shiki is ready, after which
 * results are synchronous. Unsupported languages return `null` so the
 * block stays plaintext rather than throwing.
 */
export function createShikiPlugin(): CodeHighlighterPlugin {
  const isSupported = (language: string): language is BundledLanguage =>
    SUPPORTED.has(language as BundledLanguage);

  return {
    name: "shiki",
    type: "code-highlighter",
    getSupportedLanguages: () => LANGUAGES,
    getThemes: () => [THEME, THEME],
    supportsLanguage: (language) => isSupported(language),
    highlight: (options, callback) => {
      if (!isSupported(options.language)) return null;
      const language = options.language;
      if (_highlighter) {
        try {
          return highlightTokens(_highlighter, options.code, language);
        } catch {
          return null;
        }
      }
      void loadHighlighter().then((h) => {
        try {
          callback?.(highlightTokens(h, options.code, language));
        } catch {
          // Parse failure for this block - leave it as plaintext.
        }
      });
      return null;
    },
  };
}
