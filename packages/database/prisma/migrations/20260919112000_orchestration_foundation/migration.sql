CREATE TYPE "OutboxEventStatus" AS ENUM ('PENDING', 'PUBLISHED');
CREATE TYPE "AutomationRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_type" VARCHAR(128) NOT NULL,
    "aggregate_type" VARCHAR(128) NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),
    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "automation_runs" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "outbox_event_id" UUID NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "external_run_id" VARCHAR(255),
    "status" "AutomationRunStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outbox_events_idempotency_key_key" ON "outbox_events"("idempotency_key");
CREATE INDEX "outbox_events_status_available_at_idx" ON "outbox_events"("status", "available_at");
CREATE INDEX "outbox_events_aggregate_type_aggregate_id_created_at_idx" ON "outbox_events"("aggregate_type", "aggregate_id", "created_at");
CREATE UNIQUE INDEX "automation_runs_outbox_event_id_key" ON "automation_runs"("outbox_event_id");
CREATE INDEX "automation_runs_campaign_id_created_at_idx" ON "automation_runs"("campaign_id", "created_at");
CREATE INDEX "automation_runs_status_updated_at_idx" ON "automation_runs"("status", "updated_at");

ALTER TABLE "automation_runs"
    ADD CONSTRAINT "automation_runs_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "automation_runs"
    ADD CONSTRAINT "automation_runs_outbox_event_id_fkey" FOREIGN KEY ("outbox_event_id") REFERENCES "outbox_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;
