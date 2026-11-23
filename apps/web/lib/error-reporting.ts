/**
 * Optional Sentry-compatible error reporting for the web app (PH1-02a). With no
 * DSN nothing is initialized and no network call is made. Events are scrubbed
 * before they leave: request data, users, breadcrumbs and anything shaped like
 * a credential are removed. The API has its own, stricter redactor; this one is
 * deliberately small because the browser holds no server secrets.
 */

const REDACTED = "[REDACTED]";
const MAX_TEXT = 2_000;

const SECRET_KEY =
  /(password|passwd|passphrase|secret|api[-_]?key|authorization|cookie|signature|credential|private[-_]?key|token|bearer|csrf|jwt|session[-_]?id)/i;

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  [/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, `Basic ${REDACTED}`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+):[^\s/@]+@/gi, `$1:${REDACTED}@`],
  [
    /\b([a-z0-9_-]*(?:password|passwd|secret|token|api[-_]?key|signature|authorization|credential)[a-z0-9_-]*)(\s*[=:]\s*)[^\s"&,;]{4,}/gi,
    `$1$2${REDACTED}`,
  ],
];

export function scrubText(value: string): string {
  let text = value;
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}[TRUNCATED]` : text;
}

function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return scrubText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 6) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => scrubValue(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 50)
      .map(([key, child]) => [key, SECRET_KEY.test(key) && typeof child !== "boolean" ? REDACTED : scrubValue(child, depth + 1)]),
  );
}

interface ScrubbableEvent {
  message?: string;
  exception?: { values?: Array<{ value?: string; stacktrace?: { frames?: Array<Record<string, unknown>> } }> };
  [key: string]: unknown;
}

/** Removes request data and personal context, then scrubs what remains. */
export function scrubSentryEvent<T extends object>(input: T): T {
  const event = input as ScrubbableEvent;
  const scrubbed: Record<string, unknown> = { ...event };
  for (const key of ["request", "user", "server_name", "breadcrumbs", "sdkProcessingMetadata"]) {
    delete scrubbed[key];
  }
  if (typeof scrubbed.message === "string") scrubbed.message = scrubText(scrubbed.message);
  for (const key of ["extra", "tags", "contexts"]) {
    if (scrubbed[key] !== undefined) scrubbed[key] = scrubValue(scrubbed[key]);
  }
  if (event.exception?.values) {
    scrubbed.exception = {
      ...event.exception,
      values: event.exception.values.map((entry) => ({
        ...entry,
        ...(entry.value === undefined ? {} : { value: scrubText(entry.value) }),
        ...(entry.stacktrace
          ? {
              stacktrace: {
                ...entry.stacktrace,
                // Local variable values can hold secrets, so frames keep location only.
                frames: entry.stacktrace.frames?.map((frame) => ({ ...frame, vars: undefined })),
              },
            }
          : {}),
      })),
    };
  }
  return scrubbed as unknown as T;
}

export interface WebErrorReportingEnvironment {
  dsn?: string | undefined;
  environment?: string | undefined;
  release?: string | undefined;
}

export interface WebSentryOptions {
  dsn: string;
  environment: string | undefined;
  release: string | undefined;
  sendDefaultPii: false;
  maxBreadcrumbs: 0;
  tracesSampleRate: 0;
  beforeSend: <T extends object>(event: T) => T;
}

/** Null when no DSN is configured, which is the signal not to initialize anything. */
export function buildSentryOptions(env: WebErrorReportingEnvironment): WebSentryOptions | null {
  const dsn = env.dsn?.trim();
  if (!dsn) return null;
  return {
    dsn,
    environment: env.environment || undefined,
    release: env.release || undefined,
    sendDefaultPii: false,
    maxBreadcrumbs: 0,
    tracesSampleRate: 0,
    beforeSend: scrubSentryEvent,
  };
}
