CREATE TYPE "DecisionMakerSelectionStatus" AS ENUM ('COMPLETE', 'REVIEW_REQUIRED');

ALTER TABLE "decision_maker_selections"
    ADD COLUMN "status" "DecisionMakerSelectionStatus" NOT NULL DEFAULT 'REVIEW_REQUIRED',
    ADD COLUMN "warnings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "decision_maker_assignments"
    ADD COLUMN "components" JSONB NOT NULL DEFAULT '{}'::JSONB;
