CREATE TYPE "CompanyFitFactType" AS ENUM ('HEADCOUNT', 'GEOGRAPHY', 'BUSINESS_MODEL');

CREATE TYPE "CompanyFitEvidenceState" AS ENUM ('UNKNOWN', 'VERIFIED', 'CONFLICT');

CREATE TABLE "company_fit_observations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "fact_type" "CompanyFitFactType" NOT NULL,
    "state" "CompanyFitEvidenceState" NOT NULL,
    "headcount_min" INTEGER,
    "headcount_max" INTEGER,
    "text_value" VARCHAR(500),
    "source_id" UUID,
    "captured_at" TIMESTAMPTZ(6),
    "confidence" DOUBLE PRECISION,
    "fingerprint" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "company_fit_observations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "company_fit_observations_confidence_check" CHECK (
        "confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1)
    ),
    CONSTRAINT "company_fit_observations_payload_check" CHECK (
        (
            "state" = 'UNKNOWN'
            AND "source_id" IS NULL
            AND "captured_at" IS NULL
            AND "confidence" IS NULL
            AND "headcount_min" IS NULL
            AND "headcount_max" IS NULL
            AND "text_value" IS NULL
        )
        OR
        (
            "state" IN ('VERIFIED', 'CONFLICT')
            AND "source_id" IS NOT NULL
            AND "captured_at" IS NOT NULL
            AND "confidence" IS NOT NULL
            AND (
                (
                    "fact_type" = 'HEADCOUNT'
                    AND "headcount_min" IS NOT NULL
                    AND "headcount_max" IS NOT NULL
                    AND "headcount_min" >= 0
                    AND "headcount_min" <= "headcount_max"
                    AND "text_value" IS NULL
                )
                OR
                (
                    "fact_type" IN ('GEOGRAPHY', 'BUSINESS_MODEL')
                    AND "headcount_min" IS NULL
                    AND "headcount_max" IS NULL
                    AND "text_value" IS NOT NULL
                )
            )
        )
    )
);

CREATE UNIQUE INDEX "company_fit_observations_fingerprint_key" ON "company_fit_observations"("fingerprint");
CREATE INDEX "company_fit_observations_organization_id_fact_type_state_idx" ON "company_fit_observations"("organization_id", "fact_type", "state");
CREATE INDEX "company_fit_observations_source_id_idx" ON "company_fit_observations"("source_id");

ALTER TABLE "company_fit_observations"
ADD CONSTRAINT "company_fit_observations_organization_id_fkey"
FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "company_fit_observations"
ADD CONSTRAINT "company_fit_observations_source_id_fkey"
FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
