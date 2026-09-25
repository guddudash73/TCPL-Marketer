CREATE TABLE "sources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "crawl_run_id" UUID NOT NULL,
    "crawl_attempt_id" UUID NOT NULL,
    "url" VARCHAR(2048) NOT NULL,
    "title" VARCHAR(500),
    "publisher" VARCHAR(255),
    "source_type" VARCHAR(64) NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "captured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "authority" VARCHAR(64) NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    CONSTRAINT "sources_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "web_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_id" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "fetch_method" VARCHAR(16) NOT NULL,
    "http_status" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "web_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sources_crawl_attempt_id_key" ON "sources"("crawl_attempt_id");
CREATE INDEX "sources_organization_id_captured_at_idx" ON "sources"("organization_id", "captured_at");
CREATE INDEX "sources_crawl_run_id_idx" ON "sources"("crawl_run_id");
CREATE INDEX "sources_url_idx" ON "sources"("url");
CREATE UNIQUE INDEX "web_documents_source_id_key" ON "web_documents"("source_id");

ALTER TABLE "sources" ADD CONSTRAINT "sources_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "sources" ADD CONSTRAINT "sources_crawl_run_id_fkey" FOREIGN KEY ("crawl_run_id") REFERENCES "crawl_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sources" ADD CONSTRAINT "sources_crawl_attempt_id_fkey" FOREIGN KEY ("crawl_attempt_id") REFERENCES "crawl_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "web_documents" ADD CONSTRAINT "web_documents_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "sources"("id") ON DELETE CASCADE ON UPDATE CASCADE;
