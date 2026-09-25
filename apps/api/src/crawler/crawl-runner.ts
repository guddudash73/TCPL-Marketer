import { Inject, Injectable } from "@nestjs/common";

import { DatabaseService } from "../database/database.service.js";
import { planCrawl, type CrawlPlan } from "./crawl-planner.js";
import { CrawlFetchError, fetchContent, type FetchedContent } from "./page-fetcher.js";
import { validatePublicUrl } from "./safe-http.js";

const MAX_PAGES = 25;
const PAGE_DELAY_MS = 250;

@Injectable()
export class CrawlRunner {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async run(
    organizationId: string,
    websiteUrl: string,
    plan: (url: string) => Promise<CrawlPlan> = planCrawl,
    fetch: (url: string) => Promise<FetchedContent> = fetchContent,
  ): Promise<{ runId: string; pages: FetchedContent[] }> {
    const homepageUrl = validatePublicUrl(websiteUrl).origin + "/";
    const run = await this.database.client.crawlRun.create({
      data: { organizationId, homepageUrl },
    });
    const pages: FetchedContent[] = [];
    let failures = 0;
    try {
      const crawlPlan = await plan(websiteUrl);
      for (const requestedUrl of crawlPlan.pageUrls.slice(0, MAX_PAGES)) {
        // Defend against callers that provide an untrusted or stale plan.
        try {
          if (validatePublicUrl(requestedUrl).origin !== new URL(homepageUrl).origin) {
            throw new Error("Crawler selected URL changed origin");
          }
          const result = await fetch(requestedUrl);
          if (validatePublicUrl(result.url).origin !== new URL(homepageUrl).origin) {
            throw new Error("Crawler fetched URL changed origin");
          }
          pages.push(result);
          await this.database.client.crawlAttempt.create({ data: {
            crawlRunId: run.id, requestedUrl, finalUrl: result.url,
            method: result.method, status: "SUCCEEDED", httpStatus: result.httpStatus,
            title: result.title, textLength: result.text.length,
          } });
        } catch (error) {
          failures++;
          await this.database.client.crawlAttempt.create({ data: {
            crawlRunId: run.id, requestedUrl,
            method: error instanceof CrawlFetchError ? error.method : "HTTP", status: "FAILED",
            error: errorMessage(error),
          } });
        }
        if (PAGE_DELAY_MS && crawlPlan.pageUrls.length > 1) {
          await new Promise((resolve) => setTimeout(resolve, PAGE_DELAY_MS));
        }
      }
      await this.database.client.crawlRun.update({
        where: { id: run.id },
        data: { status: pages.length ? "SUCCEEDED" : "FAILED", completedAt: new Date(),
          error: pages.length ? null : failures ? "All selected pages failed" : "No permitted pages" },
      });
      return { runId: run.id, pages };
    } catch (error) {
      await this.database.client.crawlRun.update({
        where: { id: run.id },
        data: { status: "FAILED", completedAt: new Date(), error: errorMessage(error) },
      });
      throw error;
    }
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown crawl failure").slice(0, 500);
}
