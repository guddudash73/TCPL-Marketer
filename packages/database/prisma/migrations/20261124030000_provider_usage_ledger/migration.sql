-- PH1-03a: provider usage ledger. Additive only: two enums and one table.
-- Written by hand because the Prisma schema and the migration history disagree on
-- unrelated columns (FND-024); a generated diff would carry those changes in.
CREATE TYPE "ProviderUsageStatus" AS ENUM ('RESERVED', 'SETTLED', 'RELEASED', 'EXPIRED');
CREATE TYPE "ProviderUsageUnit" AS ENUM ('USD', 'CREDITS', 'REQUESTS');

CREATE TABLE "provider_usage" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "operation" VARCHAR(64) NOT NULL,
    "call_key" VARCHAR(200) NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "campaign_id" UUID,
    "run_id" VARCHAR(64),
    "stage_run_id" UUID,
    "usage_date" DATE NOT NULL,
    "status" "ProviderUsageStatus" NOT NULL DEFAULT 'RESERVED',
    "unit" "ProviderUsageUnit" NOT NULL,
    "reserved_amount" DECIMAL(14,6) NOT NULL,
    "actual_amount" DECIMAL(14,6),
    "reserved_usd" DECIMAL(14,6) NOT NULL DEFAULT 0,
    "actual_usd" DECIMAL(14,6),
    "requests" INTEGER NOT NULL DEFAULT 0,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "credits" DECIMAL(14,6),
    "cost_known" BOOLEAN,
    "outcome_code" VARCHAR(64),
    "needs_review" BOOLEAN NOT NULL DEFAULT false,
    "reserved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reserved_until" TIMESTAMPTZ(6) NOT NULL,
    "settled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "provider_usage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "provider_usage_attempt_positive" CHECK ("attempt" >= 1),
    CONSTRAINT "provider_usage_amounts_nonnegative" CHECK (
      "reserved_amount" >= 0 AND "reserved_usd" >= 0
      AND ("actual_amount" IS NULL OR "actual_amount" >= 0)
      AND ("actual_usd" IS NULL OR "actual_usd" >= 0)
      AND "requests" >= 0
    ),
    CONSTRAINT "provider_usage_settled_has_actual" CHECK ("status" <> 'SETTLED' OR ("actual_amount" IS NOT NULL AND "cost_known" IS NOT NULL AND "settled_at" IS NOT NULL))
);

CREATE UNIQUE INDEX "provider_usage_provider_call_key_attempt_key" ON "provider_usage"("provider", "call_key", "attempt");
CREATE INDEX "provider_usage_provider_usage_date_status_idx" ON "provider_usage"("provider", "usage_date", "status");
CREATE INDEX "provider_usage_campaign_id_provider_status_idx" ON "provider_usage"("campaign_id", "provider", "status");
CREATE INDEX "provider_usage_run_id_provider_status_idx" ON "provider_usage"("run_id", "provider", "status");
CREATE INDEX "provider_usage_provider_reserved_at_idx" ON "provider_usage"("provider", "reserved_at");
CREATE INDEX "provider_usage_status_reserved_until_idx" ON "provider_usage"("status", "reserved_until");

ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "provider_usage" ADD CONSTRAINT "provider_usage_stage_run_id_fkey" FOREIGN KEY ("stage_run_id") REFERENCES "stage_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
