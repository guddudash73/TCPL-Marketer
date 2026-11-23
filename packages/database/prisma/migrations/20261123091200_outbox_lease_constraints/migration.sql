-- Integrity rules for the outbox lease and dead-letter states added by the previous migration.
-- Kept separate because a new enum value cannot be used in the transaction that adds it.
ALTER TABLE "outbox_events"
ADD CONSTRAINT "outbox_events_lease_check" CHECK (
    (
        "status" = 'PROCESSING'
        AND "lease_owner" IS NOT NULL
        AND length(trim("lease_owner")) > 0
        AND "lease_expires_at" IS NOT NULL
    )
    OR
    (
        "status" <> 'PROCESSING'
        AND "lease_owner" IS NULL
        AND "lease_expires_at" IS NULL
    )
);

ALTER TABLE "outbox_events"
ADD CONSTRAINT "outbox_events_dead_letter_check" CHECK (
    (
        "status" = 'DEAD_LETTER'
        AND "dead_lettered_at" IS NOT NULL
        AND "last_error" IS NOT NULL
        AND length(trim("last_error")) > 0
    )
    OR
    (
        "status" <> 'DEAD_LETTER'
        AND "dead_lettered_at" IS NULL
    )
);
