ALTER TABLE "company_fit_observations"
DROP CONSTRAINT "company_fit_observations_payload_check";

ALTER TABLE "company_fit_observations"
ADD CONSTRAINT "company_fit_observations_payload_check" CHECK (
    (
        "state" = 'UNKNOWN'
        AND "source_id" IS NULL
        AND "captured_at" IS NULL
        AND "confidence" IS NULL
        AND "evidence_excerpt" IS NULL
        AND cardinality("conflicting_source_ids") = 0
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
        AND "evidence_excerpt" IS NOT NULL
        AND length(trim("evidence_excerpt")) > 0
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
);
