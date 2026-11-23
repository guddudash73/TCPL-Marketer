CREATE TYPE "AcceptanceDiagnosticStatus" AS ENUM ('CLAIMED', 'VERIFIED', 'NEEDS_REVIEW');

CREATE TABLE "acceptance_diagnostic_runs" (
  "id" UUID NOT NULL,
  "lead_candidate_id" UUID NOT NULL,
  "campaign_id" UUID NOT NULL,
  "focus" VARCHAR(16) NOT NULL,
  "input_hash" CHAR(64) NOT NULL,
  "status" "AcceptanceDiagnosticStatus" NOT NULL DEFAULT 'CLAIMED',
  "external_run_id" VARCHAR(255),
  "score_id" UUID,
  "outcome" VARCHAR(128),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "acceptance_diagnostic_runs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "acceptance_diagnostic_runs_lead_candidate_id_key" ON "acceptance_diagnostic_runs"("lead_candidate_id");
CREATE INDEX "acceptance_diagnostic_runs_campaign_id_created_at_idx" ON "acceptance_diagnostic_runs"("campaign_id", "created_at");
ALTER TABLE "acceptance_diagnostic_runs" ADD CONSTRAINT "acceptance_diagnostic_runs_lead_candidate_id_fkey" FOREIGN KEY ("lead_candidate_id") REFERENCES "lead_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
