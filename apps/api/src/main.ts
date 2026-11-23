import "reflect-metadata";

import { z } from "zod";

import { createApp } from "./bootstrap.js";
import { initErrorReportingFromEnvironment } from "./observability/error-reporting.js";

const environmentSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65_535).default(4000),
});

async function bootstrap(): Promise<void> {
  const { PORT: port } = environmentSchema.parse(process.env);
  // Optional: with no SENTRY_DSN nothing is initialized and no network call is made.
  initErrorReportingFromEnvironment();
  const app = await createApp();

  await app.listen(port);
}

await bootstrap();
