-- PH1-03e: website research cache (plan section 83). Additive only.
-- Written by hand because the Prisma schema and the migration history disagree on
-- unrelated columns (FND-024); a generated diff would carry those changes in.
ALTER TABLE "organizations"
  ADD COLUMN "last_crawled_at" TIMESTAMPTZ(6),
  ADD COLUMN "website_content_hash" CHAR(64),
  ADD COLUMN "website_content_changed" BOOLEAN;

ALTER TABLE "crawl_runs"
  ADD COLUMN "served_from_cache" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "cache_source_run_id" UUID;

ALTER TABLE "crawl_runs" ADD CONSTRAINT "crawl_runs_cache_source_run_id_fkey" FOREIGN KEY ("cache_source_run_id") REFERENCES "crawl_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
