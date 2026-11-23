CREATE TYPE "DataProvenance" AS ENUM ('UNKNOWN', 'APPLICATION', 'ACCEPTANCE_FIXTURE', 'MANUALLY_REVIEWED');

ALTER TABLE "campaigns" ADD COLUMN "provenance" "DataProvenance" NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "lead_candidates" ADD COLUMN "provenance" "DataProvenance" NOT NULL DEFAULT 'UNKNOWN';
ALTER TABLE "people" ADD COLUMN "provenance" "DataProvenance" NOT NULL DEFAULT 'UNKNOWN';

-- Existing data is unknown unless its historical acceptance origin is explicit.
UPDATE "campaigns"
SET "provenance" = 'ACCEPTANCE_FIXTURE'
WHERE "name" ~* '^(D014d|D015|D016) .*Acceptance';

UPDATE "lead_candidates" AS candidate
SET "provenance" = 'ACCEPTANCE_FIXTURE'
WHERE candidate."search_strategy_type" ~* '(ACCEPTANCE|FIXTURE|TEST_ONLY)'
   OR EXISTS (
     SELECT 1 FROM "campaigns" AS campaign
     WHERE campaign."id" = candidate."campaign_id"
       AND campaign."provenance" = 'ACCEPTANCE_FIXTURE'
   );

UPDATE "people"
SET "provenance" = 'MANUALLY_REVIEWED'
WHERE "source_provider" ~* 'manually-reviewed';

UPDATE "people"
SET "provenance" = 'ACCEPTANCE_FIXTURE'
WHERE "provenance" = 'UNKNOWN'
  AND "source_provider" ~* '(fixture|controlled-live)';
