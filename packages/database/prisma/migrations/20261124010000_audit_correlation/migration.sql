-- PH1-02a: correlation IDs and a queryable campaign link on audit rows, plus
-- correlation IDs on outbox events and stage runs. Additive and nullable only.
ALTER TABLE "audit_logs" ADD COLUMN "correlation_id" VARCHAR(64);
ALTER TABLE "audit_logs" ADD COLUMN "campaign_id" UUID;
ALTER TABLE "outbox_events" ADD COLUMN "correlation_id" VARCHAR(64);
ALTER TABLE "stage_runs" ADD COLUMN "correlation_id" VARCHAR(64);

CREATE INDEX "audit_logs_correlation_id_idx" ON "audit_logs"("correlation_id");
CREATE INDEX "audit_logs_campaign_id_created_at_idx" ON "audit_logs"("campaign_id", "created_at");
