ALTER TYPE "LeadCandidateStatus" ADD VALUE 'BDE_REVIEW' BEFORE 'REJECTED';

ALTER TABLE "campaigns"
    ADD COLUMN "sector_fit_weight" INTEGER NOT NULL DEFAULT 15,
    ADD COLUMN "capability_match_weight" INTEGER NOT NULL DEFAULT 20,
    ADD COLUMN "target_client_fit_weight" INTEGER NOT NULL DEFAULT 15,
    ADD COLUMN "outsourcing_weight" INTEGER NOT NULL DEFAULT 15,
    ADD COLUMN "buying_intent_weight" INTEGER NOT NULL DEFAULT 20,
    ADD COLUMN "business_momentum_weight" INTEGER NOT NULL DEFAULT 5,
    ADD COLUMN "decision_maker_weight" INTEGER NOT NULL DEFAULT 5,
    ADD COLUMN "contact_confidence_weight" INTEGER NOT NULL DEFAULT 5,
    ADD CONSTRAINT "campaigns_scoring_weights_range_check" CHECK (
        "sector_fit_weight" BETWEEN 0 AND 100 AND
        "capability_match_weight" BETWEEN 0 AND 100 AND
        "target_client_fit_weight" BETWEEN 0 AND 100 AND
        "outsourcing_weight" BETWEEN 0 AND 100 AND
        "buying_intent_weight" BETWEEN 0 AND 100 AND
        "business_momentum_weight" BETWEEN 0 AND 100 AND
        "decision_maker_weight" BETWEEN 0 AND 100 AND
        "contact_confidence_weight" BETWEEN 0 AND 100
    ),
    ADD CONSTRAINT "campaigns_scoring_weights_total_check" CHECK (
        "sector_fit_weight" +
        "capability_match_weight" +
        "target_client_fit_weight" +
        "outsourcing_weight" +
        "buying_intent_weight" +
        "business_momentum_weight" +
        "decision_maker_weight" +
        "contact_confidence_weight" = 100
    );

ALTER TABLE "lead_scores"
    ADD COLUMN "weights" JSONB NOT NULL DEFAULT '{
        "sectorFit": 15,
        "capabilityMatch": 20,
        "targetClientFit": 15,
        "outsourcingProbability": 15,
        "buyingIntent": 20,
        "businessMomentum": 5,
        "decisionMakerQuality": 5,
        "contactConfidence": 5
    }'::jsonb;

ALTER TABLE "lead_scores" ALTER COLUMN "weights" DROP DEFAULT;
