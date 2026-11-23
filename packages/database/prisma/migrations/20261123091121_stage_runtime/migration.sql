-- CreateEnum
CREATE TYPE "StageName" AS ENUM ('DISCOVERY', 'CRAWL', 'RESEARCH', 'EXTERNAL_INTELLIGENCE', 'SCORING', 'PEOPLE', 'CONTACT');

-- CreateEnum
CREATE TYPE "StageRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'REVIEW_REQUIRED', 'CANCELLED', 'SKIPPED');

-- AlterEnum
-- PostgreSQL 12+ allows ADD VALUE in a transaction, but the new values may not be used until it commits;
-- constraints that reference them are in the next migration.
ALTER TYPE "OutboxEventStatus" ADD VALUE 'PROCESSING';
ALTER TYPE "OutboxEventStatus" ADD VALUE 'DEAD_LETTER';

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "dead_lettered_at" TIMESTAMPTZ(6),
ADD COLUMN     "lease_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "lease_owner" VARCHAR(128);

-- CreateTable
CREATE TABLE "stage_runs" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "entity_type" VARCHAR(64) NOT NULL,
    "entity_id" UUID NOT NULL,
    "stage" "StageName" NOT NULL,
    "input_hash" CHAR(64) NOT NULL,
    "status" "StageRunStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "lease_owner" VARCHAR(128),
    "lease_expires_at" TIMESTAMPTZ(6),
    "last_heartbeat_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "outcome" VARCHAR(128),
    "outcome_reason" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "stage_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "stage_runs_campaign_id_stage_status_idx" ON "stage_runs"("campaign_id", "stage", "status");

-- CreateIndex
CREATE INDEX "stage_runs_status_lease_expires_at_idx" ON "stage_runs"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "stage_runs_entity_type_entity_id_stage_input_hash_key" ON "stage_runs"("entity_type", "entity_id", "stage", "input_hash");

-- CreateIndex
CREATE INDEX "outbox_events_status_lease_expires_at_idx" ON "outbox_events"("status", "lease_expires_at");

-- AddForeignKey
ALTER TABLE "stage_runs" ADD CONSTRAINT "stage_runs_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Integrity rules for stage runs. A RUNNING run always carries a lease; no other state does.
ALTER TABLE "stage_runs"
ADD CONSTRAINT "stage_runs_lease_check" CHECK (
    (
        "status" = 'RUNNING'
        AND "lease_owner" IS NOT NULL
        AND length(trim("lease_owner")) > 0
        AND "lease_expires_at" IS NOT NULL
    )
    OR
    (
        "status" <> 'RUNNING'
        AND "lease_owner" IS NULL
        AND "lease_expires_at" IS NULL
    )
);

-- Terminal states are completed; non-terminal states are not.
ALTER TABLE "stage_runs"
ADD CONSTRAINT "stage_runs_completion_check" CHECK (
    (
        "status" IN ('SUCCEEDED', 'FAILED', 'REVIEW_REQUIRED', 'CANCELLED', 'SKIPPED')
        AND "completed_at" IS NOT NULL
    )
    OR
    (
        "status" IN ('PENDING', 'RUNNING')
        AND "completed_at" IS NULL
    )
);

ALTER TABLE "stage_runs"
ADD CONSTRAINT "stage_runs_attempt_check" CHECK ("attempt" >= 0);

ALTER TABLE "stage_runs"
ADD CONSTRAINT "stage_runs_input_hash_check" CHECK ("input_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "stage_runs"
ADD CONSTRAINT "stage_runs_entity_type_check" CHECK (length(trim("entity_type")) > 0);
