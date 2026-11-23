CREATE TYPE "DecisionMakerAssignmentSlot" AS ENUM ('PRIMARY', 'SECONDARY', 'FALLBACK');

CREATE TABLE "decision_maker_selections" (
    "id" UUID NOT NULL,
    "lead_candidate_id" UUID NOT NULL,
    "idempotency_key" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_maker_selections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "decision_maker_assignments" (
    "id" UUID NOT NULL,
    "selection_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "person_role_id" UUID NOT NULL,
    "decision_maker_profile_id" UUID NOT NULL,
    "slot" "DecisionMakerAssignmentSlot" NOT NULL,
    "rank_score" INTEGER NOT NULL,
    "reasons" TEXT[],
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_maker_assignments_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "decision_maker_assignments_rank_score_check" CHECK ("rank_score" BETWEEN 0 AND 100)
);

CREATE UNIQUE INDEX "decision_maker_selections_idempotency_key_key"
    ON "decision_maker_selections"("idempotency_key");
CREATE INDEX "decision_maker_selections_lead_candidate_id_created_at_idx"
    ON "decision_maker_selections"("lead_candidate_id", "created_at");
CREATE UNIQUE INDEX "decision_maker_assignments_selection_id_slot_key"
    ON "decision_maker_assignments"("selection_id", "slot");
CREATE UNIQUE INDEX "decision_maker_assignments_selection_id_person_id_key"
    ON "decision_maker_assignments"("selection_id", "person_id");
CREATE INDEX "decision_maker_assignments_person_id_idx"
    ON "decision_maker_assignments"("person_id");
CREATE INDEX "decision_maker_assignments_decision_maker_profile_id_idx"
    ON "decision_maker_assignments"("decision_maker_profile_id");

ALTER TABLE "decision_maker_selections"
    ADD CONSTRAINT "decision_maker_selections_lead_candidate_id_fkey"
    FOREIGN KEY ("lead_candidate_id") REFERENCES "lead_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "decision_maker_assignments"
    ADD CONSTRAINT "decision_maker_assignments_selection_id_fkey"
    FOREIGN KEY ("selection_id") REFERENCES "decision_maker_selections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "decision_maker_assignments"
    ADD CONSTRAINT "decision_maker_assignments_person_id_fkey"
    FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "decision_maker_assignments"
    ADD CONSTRAINT "decision_maker_assignments_person_role_id_fkey"
    FOREIGN KEY ("person_role_id") REFERENCES "person_roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "decision_maker_assignments"
    ADD CONSTRAINT "decision_maker_assignments_decision_maker_profile_id_fkey"
    FOREIGN KEY ("decision_maker_profile_id") REFERENCES "decision_maker_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
