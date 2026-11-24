-- PH1-03d: budget alerts and the billed-search count of a usage row. Additive only.
-- Written by hand because the Prisma schema and the migration history disagree on
-- unrelated columns (FND-024); a generated diff would carry those changes in.
CREATE TYPE "ProviderBudgetAlertKind" AS ENUM ('THRESHOLD', 'CAP_REACHED', 'EXPIRED_HOLD');

ALTER TABLE "provider_usage" ADD COLUMN "web_search_calls" INTEGER;

-- One row per alert. The unique key is what makes an alert fire once per scope,
-- window and threshold even when many calls cross it at the same moment.
CREATE TABLE "provider_budget_alerts" (
    "id" UUID NOT NULL,
    "alert_key" VARCHAR(255) NOT NULL,
    "kind" "ProviderBudgetAlertKind" NOT NULL,
    "scope" VARCHAR(16) NOT NULL,
    "provider" VARCHAR(32),
    "window_key" VARCHAR(80) NOT NULL,
    "campaign_id" UUID,
    "usage_id" UUID,
    "threshold_percent" INTEGER,
    "unit" "ProviderUsageUnit",
    "cap" DECIMAL(14,6),
    "used" DECIMAL(14,6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_budget_alerts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "provider_budget_alerts_alert_key_key" ON "provider_budget_alerts"("alert_key");
CREATE INDEX "provider_budget_alerts_campaign_id_created_at_idx" ON "provider_budget_alerts"("campaign_id", "created_at");
CREATE INDEX "provider_budget_alerts_created_at_idx" ON "provider_budget_alerts"("created_at");

ALTER TABLE "provider_budget_alerts" ADD CONSTRAINT "provider_budget_alerts_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "provider_budget_alerts" ADD CONSTRAINT "provider_budget_alerts_usage_id_fkey" FOREIGN KEY ("usage_id") REFERENCES "provider_usage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
