CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'STARTING', 'RUNNING', 'PAUSED', 'COMPLETED', 'STOPPED', 'FAILED');
CREATE TYPE "CampaignAutomationMode" AS ENUM ('MANUAL_REVIEW');

CREATE TABLE "campaigns" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "sector_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "automation_mode" "CampaignAutomationMode" NOT NULL DEFAULT 'MANUAL_REVIEW',
    "research_depth" VARCHAR(32) NOT NULL,
    "countries" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "states" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "cities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "minimum_employees" INTEGER,
    "maximum_employees" INTEGER,
    "target_lead_count" INTEGER NOT NULL,
    "minimum_score" INTEGER NOT NULL,
    "daily_email_limit" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "campaigns_employee_range_check" CHECK ("minimum_employees" IS NULL OR "maximum_employees" IS NULL OR "minimum_employees" <= "maximum_employees"),
    CONSTRAINT "campaigns_target_lead_count_check" CHECK ("target_lead_count" > 0),
    CONSTRAINT "campaigns_minimum_score_check" CHECK ("minimum_score" BETWEEN 0 AND 100),
    CONSTRAINT "campaigns_daily_email_limit_check" CHECK ("daily_email_limit" > 0)
);

CREATE TABLE "campaign_capabilities" (
    "campaign_id" UUID NOT NULL,
    "capability_id" UUID NOT NULL,
    CONSTRAINT "campaign_capabilities_pkey" PRIMARY KEY ("campaign_id", "capability_id")
);

CREATE TABLE "campaign_deliverables" (
    "campaign_id" UUID NOT NULL,
    "deliverable_id" UUID NOT NULL,
    CONSTRAINT "campaign_deliverables_pkey" PRIMARY KEY ("campaign_id", "deliverable_id")
);

CREATE TABLE "campaign_targets" (
    "campaign_id" UUID NOT NULL,
    "target_client_profile_id" UUID NOT NULL,
    CONSTRAINT "campaign_targets_pkey" PRIMARY KEY ("campaign_id", "target_client_profile_id")
);

CREATE TABLE "campaign_sequence_steps" (
    "id" UUID NOT NULL,
    "campaign_id" UUID NOT NULL,
    "step_number" INTEGER NOT NULL,
    "delay_days" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "campaign_sequence_steps_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "campaign_sequence_steps_step_number_check" CHECK ("step_number" > 0),
    CONSTRAINT "campaign_sequence_steps_delay_days_check" CHECK ("delay_days" >= 0)
);

CREATE INDEX "campaigns_status_created_at_idx" ON "campaigns"("status", "created_at");
CREATE INDEX "campaigns_sector_id_idx" ON "campaigns"("sector_id");
CREATE INDEX "campaigns_created_by_user_id_idx" ON "campaigns"("created_by_user_id");
CREATE INDEX "campaign_capabilities_capability_id_idx" ON "campaign_capabilities"("capability_id");
CREATE INDEX "campaign_deliverables_deliverable_id_idx" ON "campaign_deliverables"("deliverable_id");
CREATE INDEX "campaign_targets_target_client_profile_id_idx" ON "campaign_targets"("target_client_profile_id");
CREATE UNIQUE INDEX "campaign_sequence_steps_campaign_id_step_number_key" ON "campaign_sequence_steps"("campaign_id", "step_number");
CREATE INDEX "campaign_sequence_steps_campaign_id_step_number_idx" ON "campaign_sequence_steps"("campaign_id", "step_number");

ALTER TABLE "campaigns"
    ADD CONSTRAINT "campaigns_sector_id_fkey" FOREIGN KEY ("sector_id") REFERENCES "sectors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "campaigns"
    ADD CONSTRAINT "campaigns_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "campaign_capabilities"
    ADD CONSTRAINT "campaign_capabilities_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_capabilities"
    ADD CONSTRAINT "campaign_capabilities_capability_id_fkey" FOREIGN KEY ("capability_id") REFERENCES "service_capabilities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "campaign_deliverables"
    ADD CONSTRAINT "campaign_deliverables_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_deliverables"
    ADD CONSTRAINT "campaign_deliverables_deliverable_id_fkey" FOREIGN KEY ("deliverable_id") REFERENCES "capability_deliverables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "campaign_targets"
    ADD CONSTRAINT "campaign_targets_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "campaign_targets"
    ADD CONSTRAINT "campaign_targets_target_client_profile_id_fkey" FOREIGN KEY ("target_client_profile_id") REFERENCES "target_client_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "campaign_sequence_steps"
    ADD CONSTRAINT "campaign_sequence_steps_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
