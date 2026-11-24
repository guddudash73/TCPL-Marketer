import { AuditModule } from "../audit/audit.module.js";
import { Module } from "@nestjs/common";

import { CrawlRunner } from "./crawl-runner.js";
import { WEBSITE_CACHE_CONFIG, readWebsiteCacheConfig } from "./website-cache.config.js";

/** The factory reads and validates WEBSITE_CACHE_FRESHNESS_DAYS when the application starts. */
@Module({
  imports: [AuditModule],
  providers: [CrawlRunner, { provide: WEBSITE_CACHE_CONFIG, useFactory: () => readWebsiteCacheConfig(process.env) }],
  exports: [CrawlRunner],
})
export class CrawlerModule {}
