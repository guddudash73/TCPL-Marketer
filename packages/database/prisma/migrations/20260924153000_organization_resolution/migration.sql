-- CreateEnum
CREATE TYPE "LeadCandidateStatus" AS ENUM (
  'DISCOVERED',
  'VALIDATING',
  'RESEARCHING',
  'ANALYSING',
  'SCORING',
  'QUALIFIED',
  'REJECTED'
);

-- CreateTable
CREATE TABLE "organizations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "name" VARCHAR(240) NOT NULL,
  "normalized_name" VARCHAR(240) NOT NULL,
  "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "domain" VARCHAR(255),
  "normalized_domain" VARCHAR(255),
  "website_url" VARCHAR(2048),
  "location" VARCHAR(320) NOT NULL,
  "normalized_location" VARCHAR(320) NOT NULL,
  "fallback_key" VARCHAR(600),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_candidates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "campaign_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "status" "LeadCandidateStatus" NOT NULL DEFAULT 'DISCOVERED',
  "idempotency_key" VARCHAR(255) NOT NULL,
  "source_url" VARCHAR(2048) NOT NULL,
  "source_title" VARCHAR(500) NOT NULL,
  "summary" TEXT NOT NULL,
  "evidence_snippet" TEXT NOT NULL,
  "search_strategy_type" VARCHAR(64) NOT NULL,
  "search_query" VARCHAR(500) NOT NULL,
  "discovered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "lead_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_normalized_domain_key" ON "organizations"("normalized_domain");
CREATE UNIQUE INDEX "organizations_fallback_key_key" ON "organizations"("fallback_key");
CREATE INDEX "organizations_normalized_name_normalized_location_idx" ON "organizations"("normalized_name", "normalized_location");
CREATE UNIQUE INDEX "lead_candidates_idempotency_key_key" ON "lead_candidates"("idempotency_key");
CREATE UNIQUE INDEX "lead_candidates_campaign_id_organization_id_key" ON "lead_candidates"("campaign_id", "organization_id");
CREATE INDEX "lead_candidates_campaign_id_status_discovered_at_idx" ON "lead_candidates"("campaign_id", "status", "discovered_at");
CREATE INDEX "lead_candidates_organization_id_idx" ON "lead_candidates"("organization_id");

-- AddForeignKey
ALTER TABLE "lead_candidates" ADD CONSTRAINT "lead_candidates_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_candidates" ADD CONSTRAINT "lead_candidates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
