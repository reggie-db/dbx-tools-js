import { createHash } from "node:crypto";

type TokenizeOptions = {
  distinct?: boolean;
  lowerCase?: boolean;
  omitUriScheme?: boolean;
  omitEmailDomain?: boolean;
  camelCase?: boolean;
};

// Keys/identifiers/slugs are always lowercased; `lowerCase` is not a
// caller-configurable option.
type KeyOptions = Omit<TokenizeOptions, "lowerCase"> & {
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
  IdentifierOptions & Pick<TokenizeOptions, "lowerCase">
>;

const TOKENIZE_CAMEL_CASE_REGEXP = /[A-Z]?[a-z]+|[0-9]+|[A-Z]+(?![a-z])/g;
const TOKENIZE_NON_ALPHANUMERIC_REGEXP = /[a-zA-Z0-9]+/g;
const URI_REGEXP = /^([a-zA-Z][a-zA-Z0-9+.-]*)?:\/\/([^\s/?#][^\s]*)?$/;
const EMAIL_REGEXP =
  /^([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+)@([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)$/;

const TOKENIZE_DEFAULTS: ResolvedTokenizeOptions = {
  distinct: false,
  lowerCase: false,
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
