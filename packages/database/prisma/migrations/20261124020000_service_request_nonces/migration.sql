-- PH1-02b: durable replay protection for signed service requests. Additive only.
CREATE TABLE "service_request_nonces" (
    "caller_id" VARCHAR(64) NOT NULL,
    "request_id" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "service_request_nonces_pkey" PRIMARY KEY ("caller_id", "request_id")
);

CREATE INDEX "service_request_nonces_expires_at_idx" ON "service_request_nonces"("expires_at");
