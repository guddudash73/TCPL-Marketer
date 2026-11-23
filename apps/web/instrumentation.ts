import * as Sentry from "@sentry/nextjs";

import { buildSentryOptions } from "./lib/error-reporting";

/** Runs once per server instance (Node.js and edge). With no DSN nothing is initialized. */
export function register(): void {
  const options = buildSentryOptions({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
    environment: process.env.NODE_ENV,
    release: process.env.SENTRY_RELEASE,
  });
  if (options) Sentry.init(options);
}

/** Reports server-side request errors; a no-op while Sentry is not initialized. */
export const onRequestError = Sentry.captureRequestError;
