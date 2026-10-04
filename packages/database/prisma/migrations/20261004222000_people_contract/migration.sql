CREATE TYPE "PersonSourceType" AS ENUM ('COMPANY_WEBSITE', 'PUBLIC_WEB', 'PROVIDER');

CREATE TABLE "people" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "idempotency_key" CHAR(64) NOT NULL,
    "full_name" VARCHAR(240) NOT NULL,
    "normalized_name" VARCHAR(240) NOT NULL,
    "location" VARCHAR(320),
    "profile_url" VARCHAR(2048),
    "source_type" "PersonSourceType" NOT NULL,
    "source_provider" VARCHAR(64) NOT NULL,
    "source_person_id" VARCHAR(255),
    "source_url" VARCHAR(2048),
    "confidence" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "people_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "people_confidence_check" CHECK ("confidence" BETWEEN 0 AND 1)
);

CREATE TABLE "person_roles" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "person_id" UUID NOT NULL,
    "idempotency_key" CHAR(64) NOT NULL,
    "title" VARCHAR(240) NOT NULL,
    "normalized_title" VARCHAR(240) NOT NULL,
    "seniority" VARCHAR(80),
    "departments" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "is_current" BOOLEAN NOT NULL DEFAULT true,
    "source_url" VARCHAR(2048),
    "confidence" DOUBLE PRECISION NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "person_roles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "person_roles_confidence_check" CHECK ("confidence" BETWEEN 0 AND 1)
);

CREATE UNIQUE INDEX "people_idempotency_key_key" ON "people"("idempotency_key");
CREATE INDEX "people_organization_id_normalized_name_idx" ON "people"("organization_id", "normalized_name");
CREATE INDEX "people_source_provider_source_person_id_idx" ON "people"("source_provider", "source_person_id");
CREATE UNIQUE INDEX "person_roles_idempotency_key_key" ON "person_roles"("idempotency_key");
CREATE INDEX "person_roles_person_id_is_current_idx" ON "person_roles"("person_id", "is_current");
CREATE INDEX "person_roles_normalized_title_idx" ON "person_roles"("normalized_title");

ALTER TABLE "people" ADD CONSTRAINT "people_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "person_roles" ADD CONSTRAINT "person_roles_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "people"("id") ON DELETE CASCADE ON UPDATE CASCADE;
