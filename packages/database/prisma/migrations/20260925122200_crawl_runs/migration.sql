CREATE TYPE "CrawlRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "CrawlAttemptStatus" AS ENUM ('SUCCEEDED', 'FAILED');

CREATE TABLE "crawl_runs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "homepage_url" VARCHAR(2048) NOT NULL,
    "status" "CrawlRunStatus" NOT NULL DEFAULT 'RUNNING',
    "error" VARCHAR(500),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),
    CONSTRAINT "crawl_runs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crawl_attempts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "crawl_run_id" UUID NOT NULL,
    "requested_url" VARCHAR(2048) NOT NULL,
    "final_url" VARCHAR(2048),
    "method" VARCHAR(16) NOT NULL,
    "status" "CrawlAttemptStatus" NOT NULL,
    "http_status" INTEGER,
    "title" VARCHAR(500),
    "text_length" INTEGER,
    "error" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crawl_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "crawl_runs_organization_id_started_at_idx" ON "crawl_runs"("organization_id", "started_at");
CREATE INDEX "crawl_attempts_crawl_run_id_created_at_idx" ON "crawl_attempts"("crawl_run_id", "created_at");
ALTER TABLE "crawl_runs" ADD CONSTRAINT "crawl_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "crawl_attempts" ADD CONSTRAINT "crawl_attempts_crawl_run_id_fkey" FOREIGN KEY ("crawl_run_id") REFERENCES "crawl_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
