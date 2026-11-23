import * as Sentry from "@sentry/nextjs";

import { buildSentryOptions } from "./lib/error-reporting";

// NEXT_PUBLIC_ values are inlined at build time, so this must be a literal property access.
const options = buildSentryOptions({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NODE_ENV,
});
if (options) Sentry.init(options);

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
