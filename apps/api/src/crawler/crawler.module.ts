import { Module } from "@nestjs/common";

import { CrawlRunner } from "./crawl-runner.js";

@Module({ providers: [CrawlRunner], exports: [CrawlRunner] })
export class CrawlerModule {}
