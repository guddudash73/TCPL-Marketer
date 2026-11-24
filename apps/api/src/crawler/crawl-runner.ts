import { createHash } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";

import { ProviderCallAuditor } from "../audit/provider-call-auditor.service.js";
import { currentCorrelation } from "../common/correlation/correlation-context.js";
import { DatabaseService } from "../database/database.service.js";
import { PROVIDER_CALL_GUARD, type ProviderCallGuard } from "../provider-budget/provider-call-guard.js";
import { classifyProviderError } from "../provider-budget/provider-outcome.js";
import { planCrawl, type CrawlPlan, type PageReader } from "./crawl-planner.js";
import { CrawlFetchError, fetchContent, renderJavaScriptPage, type FetchedContent } from "./page-fetcher.js";
import { readPublicPage, validatePublicUrl } from "./safe-http.js";
import { WEBSITE_CACHE_CONFIG, type WebsiteCacheConfig } from "./website-cache.config.js";

const MAX_PAGES = 25;
const PAGE_DELAY_MS = 250;
const DAY_MS = 86_400_000;

export interface CrawlRunResult {
  runId: string;
  pages: FetchedContent[];
  /** True when a recent crawl was reused and nothing was fetched or budgeted. */
  servedFromCache?: boolean;
  /** Whether the combined content of the stored pages differs from the previous successful crawl. */
  contentChanged?: boolean | null;
}

export interface CrawlOptions {
  /** Crawl again even when the site is fresh. */
  forceRefresh?: boolean;
}

@Injectable()
export class CrawlRunner {
  private readonly logger = new Logger(CrawlRunner.name);

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ProviderCallAuditor) private readonly providerCalls: ProviderCallAuditor,
    @Inject(PROVIDER_CALL_GUARD) private readonly guard: ProviderCallGuard,
    @Inject(WEBSITE_CACHE_CONFIG) private readonly cacheConfig: WebsiteCacheConfig,
  ) {}

  async run(
    organizationId: string,
    websiteUrl: string,
    plan: (url: string, read?: PageReader) => Promise<CrawlPlan> = planCrawl,
    fetch: (
      url: string,
      read?: PageReader,
      render?: (url: string) => Promise<string>,
    ) => Promise<FetchedContent> = fetchContent,
    options: CrawlOptions = {},
  ): Promise<CrawlRunResult> {
    const homepageUrl = validatePublicUrl(websiteUrl).origin + "/";

    // A campaign that is not running never reads or writes the cache; the gateway then refuses the crawl itself.
    const campaignId = currentCorrelation()?.campaignId;
    const cacheAllowed = campaignId ? (await this.guard.check(campaignId)) === null : true;
    if (cacheAllowed && !options.forceRefresh && this.cacheConfig.freshnessDays > 0) {
      const cached = await this.serveFromCache(organizationId, homepageUrl);
      if (cached) return cached;
    }

    const run = await this.database.client.crawlRun.create({
      data: { organizationId, homepageUrl },
    });
    const pages: FetchedContent[] = [];
    let failures = 0;
    try {
      // Every outbound request of the crawl goes through the provider gateway: the plan reads robots.txt,
      // sitemaps and the homepage, and each selected page is one fetch (plus a browser render when needed).
      const crawlPlan = await this.providerCalls.run(
        { provider: "crawl", operation: "crawl-plan" },
        (call) =>
          plan(websiteUrl, (url) => {
            call.recordRequest();
            return readPublicPage(url);
          }),
      );
      for (const requestedUrl of crawlPlan.pageUrls.slice(0, MAX_PAGES)) {
        // Defend against callers that provide an untrusted or stale plan.
        try {
          if (validatePublicUrl(requestedUrl).origin !== new URL(homepageUrl).origin) {
            throw new Error("Crawler selected URL changed origin");
          }
          const result = await this.providerCalls.run(
            { provider: "crawl", operation: "page-fetch" },
            (call) =>
              fetch(
                requestedUrl,
                (url) => {
                  call.recordRequest();
                  return readPublicPage(url);
                },
                (url) => {
                  call.recordRequest();
                  return renderJavaScriptPage(url);
                },
              ),
          );
          const finalUrl = validatePublicUrl(result.url);
          if (finalUrl.origin !== new URL(homepageUrl).origin) {
            throw new Error("Crawler fetched URL changed origin");
          }
          await this.database.client.crawlAttempt.create({ data: {
            crawlRunId: run.id, requestedUrl, finalUrl: finalUrl.toString(),
            method: result.method, status: "SUCCEEDED", httpStatus: result.httpStatus,
            title: result.title, textLength: result.text.length,
            source: { create: {
              organizationId, crawlRunId: run.id, url: finalUrl.toString(),
              title: result.title || null, publisher: finalUrl.hostname,
              sourceType: "COMPANY_WEBSITE", authority: "FIRST_PARTY",
              contentHash: createHash("sha256").update(result.text, "utf8").digest("hex"),
              webDocument: { create: {
                text: result.text, fetchMethod: result.method, httpStatus: result.httpStatus,
              } },
            } },
          } });
          pages.push(result);
        } catch (error) {
          // An exhausted budget, rate limit, credit, timeout or stopped campaign ends the crawl with an
          // explained outcome; pages already stored are kept. It is not a failed page.
          if (classifyProviderError(error)) throw error;
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
      // Only a crawl that stored pages refreshes the cache; a failed crawl leaves the last good one in place.
      const contentChanged = pages.length && cacheAllowed ? await this.recordCrawl(organizationId, pages) : null;
      return { runId: run.id, pages, servedFromCache: false, contentChanged };
    } catch (error) {
      await this.database.client.crawlRun.update({
        where: { id: run.id },
        data: { status: "FAILED", completedAt: new Date(), error: errorMessage(error) },
      });
      throw error;
    }
  }

  /** Returns the stored pages of the last successful crawl when the site is still fresh, or null. */
  private async serveFromCache(organizationId: string, homepageUrl: string): Promise<CrawlRunResult | null> {
    const client = this.database.client;
    const organization = await client.organization.findUnique({
      where: { id: organizationId },
      select: { lastCrawledAt: true, websiteContentChanged: true },
    });
    const crawledAt = organization?.lastCrawledAt;
    if (!crawledAt || Date.now() - crawledAt.getTime() >= this.cacheConfig.freshnessDays * DAY_MS) return null;
    const source = await client.crawlRun.findFirst({
      where: { organizationId, homepageUrl, status: "SUCCEEDED", servedFromCache: false },
      orderBy: { startedAt: "desc" },
      include: {
        attempts: {
          where: { status: "SUCCEEDED" },
          orderBy: { createdAt: "asc" },
          include: { source: { include: { webDocument: true } } },
        },
      },
    });
    if (!source) return null;
    const pages: FetchedContent[] = source.attempts.flatMap((attempt) =>
      attempt.source?.webDocument
        ? [{
            url: attempt.source.url,
            httpStatus: attempt.source.webDocument.httpStatus ?? 200,
            method: attempt.source.webDocument.fetchMethod === "PLAYWRIGHT" ? ("PLAYWRIGHT" as const) : ("HTTP" as const),
            title: attempt.source.title ?? "",
            text: attempt.source.webDocument.text,
          }]
        : [],
    );
    if (pages.length === 0) return null;
    const run = await client.crawlRun.create({
      data: { organizationId, homepageUrl, status: "SUCCEEDED", servedFromCache: true, cacheSourceRunId: source.id, completedAt: new Date() },
    });
    return { runId: run.id, pages, servedFromCache: true, contentChanged: organization.websiteContentChanged };
  }

  /** Stores when the site was crawled and whether its combined content changed. Never fails the crawl. */
  private async recordCrawl(organizationId: string, pages: FetchedContent[]): Promise<boolean | null> {
    try {
      const hash = combinedContentHash(pages);
      const client = this.database.client;
      const previous = await client.organization.findUnique({ where: { id: organizationId }, select: { websiteContentHash: true } });
      const changed = previous?.websiteContentHash !== hash;
      await client.organization.update({
        where: { id: organizationId },
        data: { lastCrawledAt: new Date(), websiteContentHash: hash, websiteContentChanged: changed },
      });
      return changed;
    } catch {
      this.logger.warn(`The website cache could not be updated for organization ${organizationId}; the next crawl will not be served from it`);
      return null;
    }
  }
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown crawl failure").slice(0, 500);
}

/** One hash for the stored pages of a crawl: the same pages with the same text always give the same value. */
export function combinedContentHash(pages: FetchedContent[]): string {
  const entries = pages
    .map((page) => [page.url, createHash("sha256").update(page.text, "utf8").digest("hex")] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}
