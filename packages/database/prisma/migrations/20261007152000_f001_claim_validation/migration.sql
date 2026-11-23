ALTER TABLE "acceptance_diagnostic_runs" ADD COLUMN "candidate_updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;
