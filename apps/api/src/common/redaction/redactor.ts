/**
 * Shared redaction utility (PH1-02a). Every log line, audit payload, API error
 * body and Sentry event passes through here, so secrets cannot reach them by
 * accident. It is pure, never mutates its input and always returns JSON-safe data.
 */

export const REDACTED = "[REDACTED]";
export const TRUNCATED = "[TRUNCATED]";
export const CIRCULAR = "[CIRCULAR]";

export interface RedactionOptions {
  /** Maximum nesting depth before a subtree is replaced by a marker. */
  maxDepth?: number;
  /** Maximum keys or items kept per object or array. */
  maxEntries?: number;
  /** Maximum characters kept per string. */
  maxStringLength?: number;
  /** Extra exact secret values to remove from strings (added to the environment's). */
  secretValues?: readonly string[];
}

const DEFAULTS = { maxDepth: 8, maxEntries: 100, maxStringLength: 2_000 } as const;

/** A key whose value must never be kept, whatever the value looks like. */
const SECRET_KEY =
  /(password|passwd|passphrase|secret|api[-_]?key|authorization|cookie|signature|credential|private[-_]?key|token|bearer|csrf|jwt|session[-_]?id)|^(auth|dsn)$/i;

/** Counters and flags that merely contain a secret-like word are not secrets. */
const NON_SECRET_NUMERIC_KEY = /(count|tokens?|limit|max|min|length|ttl|expires?|age|seconds|ms)$/i;

const STRING_PATTERNS: readonly [RegExp, string | ((...match: string[]) => string)][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, `Basic ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, REDACTED],
  [/\bgh[pousr]_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  // user:password@host inside a URL or connection string
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/gi, `$1:${REDACTED}@`],
  // key=value or key: value for secret-like names in free text, query strings and headers
  [
    /\b((?:x-)?(?:[a-z0-9_-]*(?:password|passwd|secret|token|api[-_]?key|apikey|signature|authorization|credential)[a-z0-9_-]*))(\s*[=:]\s*)("?)[^\s"&,;]{4,}\3/gi,
    (_match, name = "", separator = "", quote = "") =>
      `${name}${separator}${quote}${REDACTED}${quote}`,
  ],
];

const SECRET_ENV_NAME = /(secret|token|password|passwd|api[_-]?key|apikey|private[_-]?key|dsn|credential|database_url|signing)/i;

/** Exact values of secret-looking environment variables, minus trivial ones. */
export function configuredSecretValues(
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(environment)) {
    if (!value || value.length < 8 || !SECRET_ENV_NAME.test(name)) continue;
    values.add(value);
    // A connection string's password is a secret on its own.
    const password = /:\/\/[^\s/:@]+:([^\s/@]+)@/.exec(value)?.[1];
    if (password && password.length >= 6) values.add(decodeURIComponentSafe(password));
  }
  return [...values].sort((a, b) => b.length - a.length);
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

/** Redact secrets inside one string. */
export function redactString(
  value: string,
  options: RedactionOptions = {},
  knownSecrets: readonly string[] = [...configuredSecretValues(), ...(options.secretValues ?? [])],
): string {
  const maxLength = options.maxStringLength ?? DEFAULTS.maxStringLength;
  let text = value.length > maxLength * 4 ? value.slice(0, maxLength * 4) : value;
  for (const secret of knownSecrets) {
    if (secret && text.includes(secret)) text = text.split(secret).join(REDACTED);
  }
  for (const [pattern, replacement] of STRING_PATTERNS) {
    text = text.replace(pattern, replacement as string);
  }
  return text.length > maxLength ? `${text.slice(0, maxLength)}${TRUNCATED}` : text;
}

/** Redact any value into plain JSON-safe data. */
export function redact(value: unknown, options: RedactionOptions = {}): unknown {
  const state: State = {
    maxDepth: options.maxDepth ?? DEFAULTS.maxDepth,
    maxEntries: options.maxEntries ?? DEFAULTS.maxEntries,
    options,
    knownSecrets: [...configuredSecretValues(), ...(options.secretValues ?? [])],
    seen: new WeakSet<object>(),
  };
  return walk(value, 0, state, undefined);
}

interface State {
  maxDepth: number;
  maxEntries: number;
  options: RedactionOptions;
  knownSecrets: readonly string[];
  seen: WeakSet<object>;
}

function walk(value: unknown, depth: number, state: State, key: string | undefined): unknown {
  if (value === null || value === undefined) return value ?? null;
  if (key !== undefined && isSecretKey(key)) {
    // A boolean cannot be a secret; counters such as inputTokens are not secrets either.
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && NON_SECRET_NUMERIC_KEY.test(key)) return value;
    return REDACTED;
  }
  switch (typeof value) {
    case "string":
      return redactString(value, state.options, state.knownSecrets);
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "function":
      return "[Function]";
    case "symbol":
      return "[Symbol]";
    default:
      break;
  }

  const object = value as object;
  if (depth >= state.maxDepth) return TRUNCATED;
  if (state.seen.has(object)) return CIRCULAR;

  if (object instanceof Date) {
    return Number.isNaN(object.getTime()) ? "Invalid Date" : object.toISOString();
  }
  if (object instanceof URL) return redactString(object.toString(), state.options, state.knownSecrets);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(object)) return `[Buffer ${object.length} bytes]`;
  if (object instanceof ArrayBuffer || ArrayBuffer.isView(object)) return "[Binary]";

  state.seen.add(object);
  try {
    if (object instanceof Error) return walkError(object, depth, state);
    if (Array.isArray(object)) {
      const items = object.slice(0, state.maxEntries).map((item) => walk(item, depth + 1, state, undefined));
      if (object.length > state.maxEntries) items.push(`${TRUNCATED} ${object.length - state.maxEntries} more`);
      return items;
    }
    if (object instanceof Set) return walk([...object], depth, state, undefined);
    if (object instanceof Map) return walk(Object.fromEntries(object), depth, state, undefined);
    return walkRecord(object as Record<string, unknown>, depth, state);
  } finally {
    state.seen.delete(object);
  }
}

function walkRecord(
  record: Record<string, unknown>,
  depth: number,
  state: State,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  let kept = 0;
  const entries = Object.entries(record);
  for (const [name, child] of entries) {
    if (kept >= state.maxEntries) {
      output["[TRUNCATED]"] = `${entries.length - kept} more keys`;
      break;
    }
    output[name] = walk(child, depth + 1, state, name);
    kept += 1;
  }
  return output;
}

function walkError(error: Error, depth: number, state: State): Record<string, unknown> {
  const output: Record<string, unknown> = {
    name: error.name,
    message: redactString(error.message, state.options, state.knownSecrets),
  };
  if (error.stack) output.stack = redactString(error.stack, state.options, state.knownSecrets);
  if ("cause" in error && error.cause !== undefined) {
    output.cause = walk(error.cause, depth + 1, state, undefined);
  }
  // Provider and HTTP client errors carry request, response and headers as own properties.
  for (const [name, child] of Object.entries(error)) {
    if (name in output) continue;
    output[name] = walk(child, depth + 1, state, name);
  }
  return output;
}
