// Direct import (not via the barrel) to avoid a self-import cycle:
// `index.client.ts` re-exports `* as stringUtils from "./src/string.js"`,
// so going back through it would close a loop.
import { fnvHashWithOptions } from "./common.js";

export type TokenizeOptions = {
  distinct?: boolean;
  lowerCase?: boolean;
  capitalize?: boolean;
  omitUriScheme?: boolean;
  omitEmailDomain?: boolean;
  camelCase?: boolean;
};

// Keys/identifiers/slugs are always lowercased; `lowerCase` is not a
// caller-configurable option.
export type KeyOptions = Omit<TokenizeOptions, "lowerCase" | "capitalize"> & {
  maxLength?: number;
  truncateStrategy?: "hash" | "trim" | "empty";
  truncateHashLength?: number;
};

export type IdentifierOptions = KeyOptions & {
  delimiter?: string;
};

type ResolvedTokenizeOptions = Required<TokenizeOptions>;
type ResolvedIdentifierOptions = Required<
  IdentifierOptions & Pick<TokenizeOptions, "lowerCase" | "capitalize">
>;

const TOKENIZE_CAMEL_CASE_REGEXP = /[A-Z]?[a-z]+|[0-9]+|[A-Z]+(?![a-z])/g;
const TOKENIZE_NON_ALPHANUMERIC_REGEXP = /[a-zA-Z0-9]+/g;
const TOKENIZE_OVERRIDES: ((token: string, options: TokenizeOptions) => string)[] = [
  (token, options) => {
    if (options.capitalize && token.toLowerCase() === "ai") {
      return "AI";
    }
    return token;
  },
];
const URI_REGEXP = /^([a-zA-Z][a-zA-Z0-9+.-]*)?:\/\/([^\s/?#][^\s]*)?$/;
const EMAIL_REGEXP =
  /^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+)@([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)$/;

const TOKENIZE_DEFAULTS: ResolvedTokenizeOptions = {
  distinct: false,
  lowerCase: false,
  capitalize: false,
  omitUriScheme: false,
  omitEmailDomain: false,
  camelCase: true,
};

const IDENTIFIER_DEFAULTS: ResolvedIdentifierOptions = {
  ...TOKENIZE_DEFAULTS,
  lowerCase: true,
  maxLength: Infinity,
  truncateStrategy: "hash",
  truncateHashLength: 6,
  delimiter: "-",
};

export function* tokenizeWithOptions(
  options: TokenizeOptions,
  ...values: unknown[]
): Generator<string> {
  const opts: ResolvedTokenizeOptions = { ...TOKENIZE_DEFAULTS, ...options };
  const seen = opts.distinct ? new Set<string>() : undefined;
  const regexp = opts.camelCase
    ? TOKENIZE_CAMEL_CASE_REGEXP
    : TOKENIZE_NON_ALPHANUMERIC_REGEXP;

  for (const value of values) {
    if (value == null) continue;
    let stringValue = typeof value === "string" ? value : String(value);
    if (!stringValue) continue;
    if (opts.omitUriScheme) {
      const match = stringValue.match(URI_REGEXP);
      if (match) stringValue = match[2] ?? "";
    }
    if (opts.omitEmailDomain) {
      const match = stringValue.match(EMAIL_REGEXP);
      if (match) stringValue = match[1] ?? "";
    }
    if (!stringValue) continue;
    for (const tokenMatch of stringValue.matchAll(regexp)) {
      let token = tokenMatch[0]!;
      if (opts.lowerCase) token = token.toLowerCase();
      if (opts.capitalize) token = token.charAt(0).toUpperCase() + token.slice(1);
      if (!token) continue;
      for (const override of TOKENIZE_OVERRIDES) {
        token = override(token, opts);
        if (!token) break;
      }
      if (!token || seen?.has(token)) continue;
      seen?.add(token);
      yield token;
    }
  }
}

export function* tokenize(...values: unknown[]): Generator<string> {
  yield* tokenizeWithOptions({}, ...values);
}

/**
 * Join tokenized values with `delimiter`. When the next token would push the
 * result over `maxLength`: `trim` stops adding; `empty` returns `""`; `hash`
 * appends a digest of accepted tokens plus the overflow token if the result
 * still fits, otherwise `""`.
 */
export function toIdentifierWithOptions(
  options: IdentifierOptions,
  ...values: unknown[]
): string {
  const opts: ResolvedIdentifierOptions = {
    ...IDENTIFIER_DEFAULTS,
    ...options,
    lowerCase: true,
  };
  const tokens: string[] = [];
  let currentLength = 0;

  for (const token of tokenizeWithOptions(opts, ...values)) {
    const sepLength = tokens.length > 0 ? opts.delimiter.length : 0;
    const nextLength = currentLength + sepLength + token.length;

    if (nextLength > opts.maxLength) {
      if (opts.truncateStrategy === "empty") return "";
      if (opts.truncateStrategy === "trim") break;

      const hash = digestTokens(opts.truncateHashLength, tokens, token);
      if (currentLength + sepLength + hash.length <= opts.maxLength) {
        return tokens.length > 0
          ? tokens.join(opts.delimiter) + opts.delimiter + hash
          : hash;
      }
      return "";
    }

    tokens.push(token);
    currentLength = nextLength;
  }

  return tokens.join(opts.delimiter);
}

export function toIdentifier(...values: unknown[]): string {
  return toIdentifierWithOptions({}, ...values);
}

/**
 * Slugified identifier: same rules as {@link toIdentifierWithOptions} with the
 * delimiter forced to `-`. Accepts {@link KeyOptions} so callers cannot
 * override the delimiter.
 */
export function toSlugWithOptions(options: KeyOptions, ...values: unknown[]): string {
  return toIdentifierWithOptions({ ...options, delimiter: "-" }, ...values);
}

export function toSlug(...values: unknown[]): string {
  return toSlugWithOptions({}, ...values);
}

/**
 * Trim `value` and return `null` for non-strings, `undefined`, or
 * strings that are empty after trimming. Lets call sites collapse the
 * common
 *
 * ```ts
 * typeof v === "string" && v.trim() ? v.trim() : null
 * ```
 *
 * dance into a single helper. Useful for HTTP header / query / form
 * extractors where downstream code wants `string | null` to drive a
 * cheap `??` / `if (x)` cascade.
 */
export function trimToNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Trim the first usable string out of `value`. Returns `null` when
 * `value` is `undefined`, `null`, an empty string, or an array whose
 * first string member is empty. Mirrors how Express / Node header
 * accessors expose single vs. repeated headers - the first
 * non-empty entry wins, everything else is ignored.
 */
export function firstNonEmpty(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const trimmed = trimToNull(item);
      if (trimmed) return trimmed;
    }
    return null;
  }
  return trimToNull(value);
}

/**
 * Escape the five characters significant in HTML text and
 * double-quoted attribute values (`&`, `<`, `>`, `"`, `'`) so an
 * untrusted string can be interpolated into markup without breaking
 * out of its context. `&` is replaced first so ampersands introduced
 * by the later replacements aren't double-escaped.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Slugify `value` (using the standard {@link toIdentifierWithOptions}
 * tokenizer + delimiter rules) and **always** suffix a short
 * deterministic hash. Use when you need a stable, slugified id that
 * is guaranteed to be unique across descriptions sharing the same
 * leading tokens (tool ids, cache keys, etc.).
 *
 * Behaviour differs from `toIdentifierWithOptions({ maxLength,
 * truncateStrategy: "hash" })`: that helper only appends a hash when
 * the slug *overflows* `maxLength`. This helper appends a hash
 * unconditionally so the result is collision-resistant even for
 * short inputs. The hash is computed over the raw `value` so two
 * descriptions producing the same slug still get different ids.
 *
 * @param value - Source string (typically a tool/agent description).
 * @param options.delimiter - Token separator (default `"_"`).
 * @param options.slugMaxLength - Cap on the slug portion (the part
 *   before the hash). Default 32.
 * @param options.hashLength - Length of the suffix produced by
 *   `commonUtils.fnvHash` (Crockford-style base-32 alphabet, max 7
 *   chars). Default 6.
 * @param options.fallbackPrefix - Prefix used when the slug is empty
 *   (e.g. punctuation-only input). Default `"id"`.
 */
export function toUniqueSlug(
  value: string,
  options: {
    delimiter?: string;
    slugMaxLength?: number;
    hashLength?: number;
    fallbackPrefix?: string;
  } = {},
): string {
  const delimiter = options.delimiter ?? "_";
  const slugMaxLength = options.slugMaxLength ?? 32;
  const hashLength = options.hashLength ?? 6;
  const fallbackPrefix = options.fallbackPrefix ?? "id";
  const slug = toIdentifierWithOptions(
    { delimiter, maxLength: slugMaxLength, truncateStrategy: "trim" },
    value,
  );
  const suffix = fnvHashWithOptions({ length: hashLength }, value);
  return slug
    ? `${slug}${delimiter}${suffix}`
    : `${fallbackPrefix}${delimiter}${suffix}`;
}

function digestTokens(
  length: number,
  parts: readonly string[],
  extra?: string,
): string {
  let combined = "";
  for (const part of parts) combined += part + "\0";
  if (extra !== undefined) combined += extra + "\0";
  return fnvHashWithOptions({ length }, combined);
}

/**
 * A node in the description tree consumed by {@link toDescription}.
 *
 * - `string` - a text paragraph.
 * - `Description[]` - a sequence of stacked blocks at the same level
 *   (no list markers). Plain text adjacent to a list (either direction)
 *   flushes together so the prose reads as a lead-in or trailing
 *   summary. Two text paragraphs, two adjacent lists, and anything
 *   touching a map get a blank-line break.
 * - `{ bullets: [...] }` / `{ numbered: [...] }` - explicit list. A
 *   list of one bare string drops its marker (`-` / `1.`); a list of
 *   one item with nested children keeps its marker as the visual anchor
 *   for the indented children.
 * - any other object - headers map: each key becomes a `Header:` line
 *   followed by a blank line and the rendered value.
 */
export type Description =
  | string
  | readonly Description[]
  | { readonly [key: string]: Description };

const LIST_KEYS = ["bullets", "numbered"] as const;
type ListKind = (typeof LIST_KEYS)[number];

/**
 * Format a nested description tree as a Markdown-ish string suitable
 * for an LLM system prompt, Zod `.describe()` block, Mastra tool
 * description, or any other long-form text destination.
 *
 * Every string section is dedented (common leading whitespace stripped),
 * right-trimmed line by line, and freed of leading / trailing blank
 * lines, so callers can write multi-line template literals indented
 * naturally in source without leaking that indentation into the
 * consumer-facing output. Plain-string inputs flow through unchanged
 * apart from the same normalization pass, so a single multi-line
 * template literal works directly:
 *
 * ```ts
 * toDescription(`
 *   Ask the Genie space "${alias}" a question.
 *   Pass the answer through as-is.
 * `);
 * // Ask the Genie space "default" a question.
 * // Pass the answer through as-is.
 *
 * toDescription([
 *   `
 *     Ask the Genie space a question.
 *     Phrase it from the user's perspective.
 *   `,
 *   { bullets: [
 *     ["Pass the answer through as-is", { numbered: ["item", "item"] }],
 *   ]},
 *   { Instructions: "Reply with the SQL only." },
 * ]);
 * // Ask the Genie space a question.
 * // Phrase it from the user's perspective.
 * // - Pass the answer through as-is
 * //   1. item
 * //   2. item
 * //
 * // Instructions:
 * //
 * // Reply with the SQL only.
 * ```
 *
 * See {@link Description} for the node grammar.
 */
export function toDescription(node: Description): string {
  return renderBlock(node, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n+$/, "");
}

function renderBlock(node: Description, pad: string): string {
  if (node == null) return "";
  if (typeof node === "string") return prependPad(dedentSection(node), pad);
  if (Array.isArray(node)) return renderSequence(node, pad);
  const kind = listKind(node as Record<string, unknown>);
  if (kind) {
    return renderList(
      (node as Record<ListKind, readonly Description[]>)[kind],
      pad,
      kind,
    );
  }
  return renderMap(node as Record<string, Description>, pad);
}

/**
 * Normalize a string section: right-strip every line, drop the
 * common leading-whitespace prefix shared by all non-blank lines,
 * and trim leading / trailing blank lines. Matches Python's
 * `textwrap.dedent` semantics so embedded indented template
 * literals round-trip cleanly.
 */
function dedentSection(text: string): string {
  if (!text) return "";
  const lines = text.split("\n").map((line) => line.replace(/[ \t]+$/, ""));
  let min = Infinity;
  for (const line of lines) {
    if (!line) continue;
    const match = /^[ \t]*/.exec(line);
    const width = match ? match[0].length : 0;
    if (width < min) min = width;
  }
  const stripped =
    min === Infinity || min === 0
      ? lines
      : lines.map((line) => (line ? line.slice(min) : ""));
  let start = 0;
  let end = stripped.length;
  while (start < end && !stripped[start]) start += 1;
  while (end > start && !stripped[end - 1]) end -= 1;
  return stripped.slice(start, end).join("\n");
}

/**
 * An object is treated as a typed list only when it has exactly one
 * own key, that key is `bullets` or `numbered`, and the value is an
 * array. Everything else is a headers map - so callers wanting a
 * single header literally named `bullets` or `numbered` can use a
 * multi-key map or rename.
 */
function listKind(node: Record<string, unknown>): ListKind | null {
  const keys = Object.keys(node);
  if (keys.length !== 1) return null;
  const key = keys[0]!;
  if ((LIST_KEYS as readonly string[]).includes(key) && Array.isArray(node[key])) {
    return key as ListKind;
  }
  return null;
}

function prependPad(text: string, pad: string): string {
  if (!text) return "";
  if (!pad) return text;
  return text
    .split("\n")
    .map((line) => (line ? pad + line : ""))
    .join("\n");
}

function renderSequence(items: readonly Description[], pad: string): string {
  const rendered: { text: string; node: Description }[] = [];
  for (const item of items) {
    const text = renderBlock(item, pad);
    if (!text) continue;
    rendered.push({ text, node: item });
  }
  if (rendered.length === 0) return "";
  let out = rendered[0]!.text;
  for (let i = 1; i < rendered.length; i += 1) {
    const sep = needsBlankLineBetween(rendered[i - 1]!.node, rendered[i]!.node)
      ? "\n\n"
      : "\n";
    out += sep + rendered[i]!.text;
  }
  return out;
}

/**
 * Maps always create their own section boundary (a `Header:` line plus
 * a blank line before the body), so anything touching a map gets a
 * blank-line break. Plain text adjacent to a typed list flushes
 * together in either direction: text-before-list reads as a lead-in,
 * text-after-list as a trailing summary. Two text paragraphs and two
 * adjacent lists both get a blank-line break for legibility.
 */
function needsBlankLineBetween(prev: Description, curr: Description): boolean {
  if (isMap(prev) || isMap(curr)) return true;
  const prevIsText = typeof prev === "string";
  const currIsText = typeof curr === "string";
  if (prevIsText !== currIsText) return false;
  return true;
}

/**
 * A node is a headers map when it is a non-array, non-list object.
 * `bullets` / `numbered` single-key objects are the only structured
 * objects that aren't maps.
 */
function isMap(node: Description): boolean {
  if (node == null) return false;
  if (typeof node === "string") return false;
  if (Array.isArray(node)) return false;
  return listKind(node as Record<string, unknown>) === null;
}

function renderList(
  items: readonly Description[],
  pad: string,
  kind: ListKind,
): string {
  if (items.length === 0) return "";
  if (items.length === 1 && typeof items[0] === "string") {
    return prependPad(items[0], pad);
  }
  const lines: string[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const marker = kind === "bullets" ? "- " : `${i + 1}. `;
    const body = renderBlock(item, "");
    const bodyLines = body.split("\n");
    lines.push(`${pad}${marker}${bodyLines[0] ?? ""}`);
    const continuation = pad + " ".repeat(marker.length);
    for (const line of bodyLines.slice(1)) {
      lines.push(line ? `${continuation}${line}` : "");
    }
  }
  return lines.join("\n");
}

function renderMap(node: Record<string, Description>, pad: string): string {
  const parts: string[] = [];
  for (const [header, value] of Object.entries(node)) {
    const body = renderBlock(value, pad);
    if (!body && !header.trim()) continue;
    const headerLine = header.trim() ? `${pad}${header}:` : "";
    parts.push(body ? `${headerLine}\n\n${body}` : headerLine);
  }
  return parts.join("\n\n");
}
