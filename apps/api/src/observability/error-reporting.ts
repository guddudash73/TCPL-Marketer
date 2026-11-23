import * as Sentry from "@sentry/node";

import { redact, redactString } from "../common/redaction/redactor.js";

/**
 * Optional Sentry-compatible error reporting (PH1-02a). With no DSN the SDK is
 * never initialized, so the application makes no network call and behaves the
 * same. Every event is scrubbed by the shared redactor before it can leave.
 */

export interface ErrorReportingOptions {
  dsn?: string | undefined;
  environment?: string | undefined;
  release?: string | undefined;
  /** Test seam: receives the envelope instead of the network. */
  transport?: Sentry.NodeOptions["transport"] | undefined;
}

let enabled = false;

export function initErrorReporting(options: ErrorReportingOptions): boolean {
  const dsn = options.dsn?.trim();
  if (!dsn) {
    enabled = false;
    return false;
  }
  Sentry.init({
    dsn,
    environment: options.environment,
    release: options.release,
    sendDefaultPii: false,
    maxBreadcrumbs: 0,
    // No tracing, no performance data, no automatic request or console capture.
    defaultIntegrations: false,
    integrations: [
      Sentry.onUncaughtExceptionIntegration(),
      Sentry.onUnhandledRejectionIntegration(),
      Sentry.linkedErrorsIntegration(),
    ],
    beforeSend: (event) => scrubSentryEvent(event),
    ...(options.transport ? { transport: options.transport } : {}),
  });
  enabled = true;
  return true;
}

/**
 * The one startup path: main.ts calls this with the process environment. With no
 * SENTRY_DSN nothing is initialized and no network call is made.
 */
export function initErrorReportingFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  overrides: Pick<ErrorReportingOptions, "transport"> = {},
): boolean {
  return initErrorReporting({
    dsn: environment.SENTRY_DSN,
    environment: environment.SENTRY_ENVIRONMENT || environment.NODE_ENV,
    release: environment.SENTRY_RELEASE,
    ...overrides,
  });
}

export function isErrorReportingEnabled(): boolean {
  return enabled;
}

/** No-op when reporting is disabled. */
export function reportError(
  error: unknown,
  context: { correlationId?: string | undefined; campaignId?: string | undefined } = {},
): void {
  if (!enabled) return;
  Sentry.captureException(error, {
    tags: {
      ...(context.correlationId ? { correlationId: context.correlationId } : {}),
      ...(context.campaignId ? { campaignId: context.campaignId } : {}),
    },
  });
}

export async function flushErrorReporting(timeoutMs = 2_000): Promise<void> {
  if (enabled) await Sentry.flush(timeoutMs);
}

export async function shutdownErrorReporting(): Promise<void> {
  if (enabled) await Sentry.close(2_000);
  enabled = false;
}

/** Removes request data and personal context, then redacts everything that is left. */
export function scrubSentryEvent<T extends Sentry.ErrorEvent>(event: T): T {
  const scrubbed = { ...event } as unknown as Record<string, unknown>;
  delete scrubbed.request;
  delete scrubbed.user;
  delete scrubbed.server_name;
  delete scrubbed.breadcrumbs;
  delete scrubbed.sdkProcessingMetadata;
  if (typeof scrubbed.message === "string") scrubbed.message = redactString(scrubbed.message);
  for (const key of ["extra", "tags", "contexts"] as const) {
    if (scrubbed[key] !== undefined) scrubbed[key] = redact(scrubbed[key]);
  }
  const exception = event.exception;
  if (exception?.values) {
    scrubbed.exception = {
      ...exception,
      values: exception.values.map((entry) => ({
        ...entry,
        ...(entry.value === undefined ? {} : { value: redactString(entry.value) }),
        ...(entry.stacktrace
          ? {
              stacktrace: {
                ...entry.stacktrace,
                // Local variable values can hold secrets, so frames keep location only.
                frames: entry.stacktrace.frames?.map((frame) => ({
                  ...frame,
                  vars: undefined,
                })),
              },
            }
          : {}),
      })),
    };
  }
  return scrubbed as unknown as T;
}
