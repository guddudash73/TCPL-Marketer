ALTER TABLE "company_fit_observations"
ADD COLUMN "evidence_excerpt" TEXT,
ADD COLUMN "conflicting_source_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
ADD COLUMN "extraction_run_id" UUID;

CREATE INDEX "company_fit_observations_extraction_run_id_idx"
ON "company_fit_observations"("extraction_run_id");

ALTER TABLE "company_fit_observations"
ADD CONSTRAINT "company_fit_observations_extraction_run_id_fkey"
FOREIGN KEY ("extraction_run_id") REFERENCES "claim_extraction_runs"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
