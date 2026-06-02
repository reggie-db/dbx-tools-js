import { createHash } from "node:crypto";

type TokenizeOptions = {
  distinct?: boolean;
  lowerCase?: boolean;
  capitalize?: boolean;
  omitUriScheme?: boolean;
  omitEmailDomain?: boolean;
  camelCase?: boolean;
};

// Keys/identifiers/slugs are always lowercased; `lowerCase` is not a
// caller-configurable option.
type KeyOptions = Omit<TokenizeOptions, "lowerCase" | "capitalize"> & {
  maxLength?: number;
  truncateStrategy?: "hash" | "trim" | "empty";
  truncateHashAlgorithm?: string;
  truncateHashLength?: number;
};

type IdentifierOptions = KeyOptions & {
  delimiter?: string;
};

type ResolvedTokenizeOptions = Required<TokenizeOptions>;
type ResolvedIdentifierOptions = Required<
  IdentifierOptions & Pick<TokenizeOptions, "lowerCase" | "capitalize">
>;

const TOKENIZE_CAMEL_CASE_REGEXP = /[A-Z]?[a-z]+|[0-9]+|[A-Z]+(?![a-z])/g;
const TOKENIZE_NON_ALPHANUMERIC_REGEXP = /[a-zA-Z0-9]+/g;
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
  truncateHashAlgorithm: "sha1",
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

      const hash = digestTokens(
        opts.truncateHashAlgorithm,
        opts.truncateHashLength,
        tokens,
        token,
      );
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
 * Tagged-template helper that collapses a multi-line indented
 * template literal into a single space-joined string. Lets call
 * sites write Zod `.describe()` blocks, Mastra tool descriptions,
 * and other long prose constants as readable indented paragraphs
 * in source while still emitting clean text the LLM (or any other
 * consumer) doesn't have to mentally re-flow. Interpolated values
 * are stringified verbatim and folded with the surrounding
 * whitespace.
 *
 * ```ts
 * toDescription`
 *   Ask the Genie space "${alias}" a question.
 *   Pass the answer through as-is.
 * `;
 * // -> 'Ask the Genie space "default" a question. Pass the answer through as-is.'
 * ```
 */
export function toDescription(
  strings: TemplateStringsArray,
  ...values: unknown[]
): string {
  let out = "";
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i];
    if (i < values.length) out += String(values[i]);
  }
  return out.replace(/\s+/g, " ").trim();
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
 * @param options.hashLength - Hex digits of SHA-1 to append.
 *   Default 6.
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
  const hash = createHash("sha1").update(value).digest("hex").slice(0, hashLength);
  return slug ? `${slug}${delimiter}${hash}` : `${fallbackPrefix}${delimiter}${hash}`;
}

function digestTokens(
  algorithm: string,
  length: number,
  parts: readonly string[],
  extra?: string,
): string {
  const hash = createHash(algorithm);
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  if (extra !== undefined) {
    hash.update(extra);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, length);
}
