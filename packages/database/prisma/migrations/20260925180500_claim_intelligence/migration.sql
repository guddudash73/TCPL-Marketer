CREATE TYPE "ClaimExtractionRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "claim_extraction_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "idempotency_key" CHAR(64) NOT NULL,
    "document_set_hash" CHAR(64) NOT NULL,
    "provider" VARCHAR(64) NOT NULL,
    "model" VARCHAR(128) NOT NULL,
    "prompt_name" VARCHAR(128) NOT NULL,
    "prompt_version" VARCHAR(64) NOT NULL,
    "status" "ClaimExtractionRunStatus" NOT NULL DEFAULT 'RUNNING',
    "provider_response_id" VARCHAR(255),
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "total_tokens" INTEGER,
    "error" VARCHAR(500),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    CONSTRAINT "claim_extraction_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "claims" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "extraction_run_id" UUID NOT NULL,
    "claim_type" VARCHAR(64) NOT NULL,
    "statement" TEXT NOT NULL,
    "fingerprint" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "claims_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "claim_evidence" (
    "claim_id" UUID NOT NULL,
    "source_id" UUID NOT NULL,
    CONSTRAINT "claim_evidence_pkey" PRIMARY KEY ("claim_id", "source_id")
);

CREATE UNIQUE INDEX "claim_extraction_runs_idempotency_key_key" ON "claim_extraction_runs"("idempotency_key");
CREATE INDEX "claim_extraction_runs_organization_id_status_started_at_idx" ON "claim_extraction_runs"("organization_id", "status", "started_at");
CREATE UNIQUE INDEX "claims_extraction_run_id_fingerprint_key" ON "claims"("extraction_run_id", "fingerprint");
CREATE INDEX "claims_organization_id_claim_type_idx" ON "claims"("organization_id", "claim_type");
CREATE INDEX "claim_evidence_source_id_idx" ON "claim_evidence"("source_id");

ALTER TABLE "claim_extraction_runs" ADD CONSTRAINT "claim_extraction_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "claims" ADD CONSTRAINT "claims_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "claims" ADD CONSTRAINT "claims_extraction_run_id_fkey" FOREIGN KEY ("extraction_run_id") REFERENCES "claim_extraction_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "claim_evidence" ADD CONSTRAINT "claim_evidence_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
