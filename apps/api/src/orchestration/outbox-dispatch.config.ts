import { ServiceUnavailableException } from "@nestjs/common";
import { z } from "zod";

const integer = (minimum: number, maximum: number, fallback: number) =>
  z.coerce.number().int().min(minimum).max(maximum).default(fallback);

const environmentSchema = z
  .object({
    // Off by default: automatic dispatch can trigger paid provider calls.
    OUTBOX_DISPATCH_ENABLED: z.enum(["true", "false"]).default("false"),
    OUTBOX_MAX_ATTEMPTS: integer(1, 20, 8),
    OUTBOX_RETRY_BASE_MS: integer(100, 300_000, 5_000),
    OUTBOX_RETRY_MAX_MS: integer(100, 86_400_000, 900_000),
    OUTBOX_LEASE_SECONDS: integer(5, 3_600, 180),
    OUTBOX_BATCH_SIZE: integer(1, 100, 5),
    OUTBOX_TICK_BUDGET_MS: integer(1_000, 300_000, 30_000),
    OUTBOX_HOLD_SECONDS: integer(5, 86_400, 300),
    STAGE_LEASE_SECONDS: integer(5, 3_600, 120),
    N8N_REQUEST_TIMEOUT_MS: integer(1_000, 300_000, 120_000),
  })
  .refine((value) => value.OUTBOX_RETRY_MAX_MS >= value.OUTBOX_RETRY_BASE_MS, {
    message: "OUTBOX_RETRY_MAX_MS must be at least OUTBOX_RETRY_BASE_MS",
  })
  .refine(
    (value) => value.OUTBOX_LEASE_SECONDS * 1_000 > value.N8N_REQUEST_TIMEOUT_MS,
    {
      message:
        "OUTBOX_LEASE_SECONDS must outlast N8N_REQUEST_TIMEOUT_MS so a live publish keeps its lease",
    },
  );

export interface OutboxDispatchConfig {
  enabled: boolean;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  leaseSeconds: number;
  batchSize: number;
  tickBudgetMs: number;
  holdSeconds: number;
  stageLeaseSeconds: number;
}

export function readOutboxDispatchConfig(
  environment: NodeJS.ProcessEnv = process.env,
): OutboxDispatchConfig {
  const parsed = environmentSchema.safeParse(environment);
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => issue.path.join(".") || issue.message)
      .join(", ");
    throw new ServiceUnavailableException(
      `Outbox dispatch configuration is invalid: ${fields}`,
    );
  }
  const value = parsed.data;
  return {
    enabled: value.OUTBOX_DISPATCH_ENABLED === "true",
    maxAttempts: value.OUTBOX_MAX_ATTEMPTS,
    retryBaseMs: value.OUTBOX_RETRY_BASE_MS,
    retryMaxMs: value.OUTBOX_RETRY_MAX_MS,
    leaseSeconds: value.OUTBOX_LEASE_SECONDS,
    batchSize: value.OUTBOX_BATCH_SIZE,
    tickBudgetMs: value.OUTBOX_TICK_BUDGET_MS,
    holdSeconds: value.OUTBOX_HOLD_SECONDS,
    stageLeaseSeconds: value.STAGE_LEASE_SECONDS,
  };
}

/**
 * Exponential backoff with equal jitter: half the capped delay is fixed and
 * half is random, so retries spread out but never fire immediately.
 */
export function computeRetryDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const capped = Math.min(maxMs, baseMs * 2 ** Math.min(exponent, 30));
  return Math.round(capped / 2 + random() * (capped / 2));
}
