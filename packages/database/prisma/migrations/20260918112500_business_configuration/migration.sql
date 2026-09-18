CREATE TABLE "sectors" (
    "id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "terminology" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "geographies" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "negative_terms" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "research_rules" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "sectors_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "service_capabilities" (
    "id" UUID NOT NULL,
    "sector_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "business_problems" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "business_value" TEXT,
    "search_guidance" JSONB,
    "research_guidance" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "service_capabilities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "capability_deliverables" (
    "id" UUID NOT NULL,
    "capability_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "description" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "capability_deliverables_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "target_client_profiles" (
    "id" UUID NOT NULL,
    "capability_id" UUID NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "slug" VARCHAR(160) NOT NULL,
    "company_characteristics" JSONB,
    "minimum_employees" INTEGER,
    "maximum_employees" INTEGER,
    "geographies" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "positive_terms" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "negative_terms" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "typical_business_model" TEXT,
    "outsourcing_characteristics" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "target_client_profiles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "decision_maker_profiles" (
    "id" UUID NOT NULL,
    "capability_id" UUID NOT NULL,
    "title" VARCHAR(160) NOT NULL,
    "priority" INTEGER NOT NULL,
    "seniorities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "positive_terms" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "negative_terms" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    CONSTRAINT "decision_maker_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sectors_slug_key" ON "sectors"("slug");
CREATE UNIQUE INDEX "service_capabilities_sector_id_slug_key" ON "service_capabilities"("sector_id", "slug");
CREATE INDEX "service_capabilities_sector_id_is_active_idx" ON "service_capabilities"("sector_id", "is_active");
CREATE UNIQUE INDEX "capability_deliverables_capability_id_slug_key" ON "capability_deliverables"("capability_id", "slug");
CREATE INDEX "capability_deliverables_capability_id_is_active_idx" ON "capability_deliverables"("capability_id", "is_active");
CREATE UNIQUE INDEX "target_client_profiles_capability_id_slug_key" ON "target_client_profiles"("capability_id", "slug");
CREATE INDEX "target_client_profiles_capability_id_is_active_idx" ON "target_client_profiles"("capability_id", "is_active");
CREATE UNIQUE INDEX "decision_maker_profiles_capability_id_title_key" ON "decision_maker_profiles"("capability_id", "title");
CREATE INDEX "decision_maker_profiles_capability_id_priority_idx" ON "decision_maker_profiles"("capability_id", "priority");

ALTER TABLE "service_capabilities"
    ADD CONSTRAINT "service_capabilities_sector_id_fkey" FOREIGN KEY ("sector_id") REFERENCES "sectors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "capability_deliverables"
    ADD CONSTRAINT "capability_deliverables_capability_id_fkey" FOREIGN KEY ("capability_id") REFERENCES "service_capabilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "target_client_profiles"
    ADD CONSTRAINT "target_client_profiles_capability_id_fkey" FOREIGN KEY ("capability_id") REFERENCES "service_capabilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "decision_maker_profiles"
    ADD CONSTRAINT "decision_maker_profiles_capability_id_fkey" FOREIGN KEY ("capability_id") REFERENCES "service_capabilities"("id") ON DELETE CASCADE ON UPDATE CASCADE;
