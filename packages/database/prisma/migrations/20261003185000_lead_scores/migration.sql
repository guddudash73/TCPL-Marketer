CREATE TYPE "LeadGrade" AS ENUM ('A_PLUS_URGENT', 'A', 'B', 'C_REVIEW', 'REJECT');
CREATE TYPE "ScoringRecommendedAction" AS ENUM ('URGENT_BDE_REVIEW', 'STANDARD_REVIEW', 'REJECT');

CREATE TABLE "lead_scores" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lead_candidate_id" UUID NOT NULL,
    "claim_extraction_run_id" UUID NOT NULL,
    "idempotency_key" CHAR(64) NOT NULL,
    "score" INTEGER NOT NULL,
    "need_score" INTEGER NOT NULL,
    "intent_score" INTEGER NOT NULL,
    "grade" "LeadGrade" NOT NULL,
    "qualified" BOOLEAN NOT NULL,
    "recommended_action" "ScoringRecommendedAction" NOT NULL,
    "minimum_score" INTEGER NOT NULL,
    "components" JSONB NOT NULL,
    "reasons" TEXT[] NOT NULL,
    "evidence_ids" UUID[] NOT NULL,
    "high_intent_override" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lead_scores_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "lead_scores_score_check" CHECK ("score" BETWEEN 0 AND 100),
    CONSTRAINT "lead_scores_need_score_check" CHECK ("need_score" BETWEEN 0 AND 100),
    CONSTRAINT "lead_scores_intent_score_check" CHECK ("intent_score" BETWEEN 0 AND 100),
    CONSTRAINT "lead_scores_minimum_score_check" CHECK ("minimum_score" BETWEEN 0 AND 100)
);

CREATE UNIQUE INDEX "lead_scores_idempotency_key_key" ON "lead_scores"("idempotency_key");
CREATE INDEX "lead_scores_lead_candidate_id_created_at_idx" ON "lead_scores"("lead_candidate_id", "created_at");
CREATE INDEX "lead_scores_claim_extraction_run_id_idx" ON "lead_scores"("claim_extraction_run_id");
CREATE INDEX "lead_scores_grade_qualified_created_at_idx" ON "lead_scores"("grade", "qualified", "created_at");

ALTER TABLE "lead_scores" ADD CONSTRAINT "lead_scores_lead_candidate_id_fkey" FOREIGN KEY ("lead_candidate_id") REFERENCES "lead_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lead_scores" ADD CONSTRAINT "lead_scores_claim_extraction_run_id_fkey" FOREIGN KEY ("claim_extraction_run_id") REFERENCES "claim_extraction_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
