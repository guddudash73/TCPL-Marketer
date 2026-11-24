import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@tcpl-marketer/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditService } from "../src/audit/audit.service.js";
import { ProviderCallAuditor } from "../src/audit/provider-call-auditor.service.js";
import { runWithCorrelation, bindCampaign } from "../src/common/correlation/correlation-context.js";
import { ClaimExtractionService } from "../src/company-intelligence/claim-extraction.service.js";
import { CompanyFitEvidenceService } from "../src/company-intelligence/company-fit-evidence.service.js";
import { CrawlRunner, combinedContentHash } from "../src/crawler/crawl-runner.js";
import { WebsiteCacheConfigError, readWebsiteCacheConfig } from "../src/crawler/website-cache.config.js";
import type { DatabaseService } from "../src/database/database.service.js";
import { readProviderBudgetConfig } from "../src/provider-budget/provider-budget.config.js";
import { CampaignProviderCallGuard } from "../src/provider-budget/provider-call-guard.js";
import { classifyProviderError } from "../src/provider-budget/provider-outcome.js";
import { ProviderUsageLedger } from "../src/provider-budget/provider-usage-ledger.service.js";
import { TEST_BUDGET_ENV } from "./support/budget-env.js";

// Private database per file: the dev database and other files' rows are never touched.
const baseUrl = process.env.DATABASE_URL ?? "postgresql://app:app@localhost:5432/tcpl_marketer";
const databaseName = `tcpl_test_webcache_${randomUUID().replaceAll("-", "")}`;
const privateUrl = new URL(baseUrl);
privateUrl.pathname = `/${databaseName}`;
const environmentKeys = ["DATABASE_URL", "DIRECT_URL"] as const;
const saved: Record<string, string | undefined> = {};

const SITE = "https://cache.example";
const DAY_MS = 86_400_000;

describe("website research cache (private PostgreSQL database)", () => {
  const admin = createPrismaClient(baseUrl);
  let database: ReturnType<typeof createPrismaClient>;
  let databaseService: DatabaseService;
  let gateway: ProviderCallAuditor;
  let userId = "";
  let sectorId = "";
  let organizationId = "";
  let text = "";

  const runnerWith = (freshnessDays: number) =>
    new CrawlRunner(databaseService, gateway, new CampaignProviderCallGuard(databaseService), { freshnessDays });

  /** A crawl whose plan and page fetches are stubs, so no network is used. */
  function crawl(runner: CrawlRunner, options: { forceRefresh?: boolean; site?: string; failPages?: boolean } = {}) {
    const site = options.site ?? SITE;
    const plan = vi.fn().mockImplementation(() => Promise.resolve({ homepageUrl: `${site}/`, robotsUrl: `${site}/robots.txt`, sitemapUrls: [], pageUrls: [`${site}/`, `${site}/about`] }));
    const fetcher = vi.fn().mockImplementation((url: string) =>
      options.failPages
        ? Promise.reject(new Error("Page unavailable"))
        : Promise.resolve({ url, httpStatus: 200, method: "HTTP" as const, title: `Title ${url}`, text: `${text} ${url}` }),
    );
    const result = runner.run(organizationId, site, plan, fetcher, { forceRefresh: options.forceRefresh });
    return { result, plan, fetcher };
  }

  const ledgerRows = () => database.providerUsage.count({ where: { provider: "crawl" } });
  const organization = () => database.organization.findUniqueOrThrow({ where: { id: organizationId } });

  async function campaign(status: "RUNNING" | "STOPPED") {
    return database.campaign.create({
      data: { name: `PH1-03e ${randomUUID()}`, sectorId, createdByUserId: userId, status, researchDepth: "STANDARD", targetLeadCount: 3, minimumScore: 70, dailyEmailLimit: 10 },
    });
  }

  beforeAll(async () => {
    for (const name of environmentKeys) saved[name] = process.env[name];
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    process.env.DATABASE_URL = privateUrl.toString();
    process.env.DIRECT_URL = privateUrl.toString();
    execSync("pnpm --filter @tcpl-marketer/database exec prisma migrate deploy", { env: process.env, stdio: "ignore" });
    database = createPrismaClient(privateUrl.toString());
    databaseService = { client: database } as unknown as DatabaseService;
    const ledger = new ProviderUsageLedger(databaseService, readProviderBudgetConfig({ ...TEST_BUDGET_ENV } as NodeJS.ProcessEnv));
    gateway = new ProviderCallAuditor(new AuditService(databaseService), ledger, new CampaignProviderCallGuard(databaseService));
    userId = (await database.user.create({ data: { email: `ph103e-${randomUUID()}@example.test`, passwordHash: "unused" } })).id;
    sectorId = (await database.sector.create({ data: { name: "PH1-03e sector", slug: `ph103e-${randomUUID()}` } })).id;
  }, 120_000);

  afterAll(async () => {
    await database?.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.$disconnect();
    for (const name of environmentKeys) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  beforeEach(async () => {
    text = "We provide aerial LiDAR mapping and survey processing services.";
    organizationId = (
      await database.organization.create({
        data: { name: "Cache Example Survey", normalizedName: `cache-example-${randomUUID()}`, location: "Calgary", normalizedLocation: "calgary" },
      })
    ).id;
  });

  describe("configuration", () => {
    it("defaults to 14 days, accepts 0 to 365, and refuses anything else naming only the variable", () => {
      expect(readWebsiteCacheConfig({})).toEqual({ freshnessDays: 14 });
      expect(readWebsiteCacheConfig({ WEBSITE_CACHE_FRESHNESS_DAYS: "" })).toEqual({ freshnessDays: 14 });
      expect(readWebsiteCacheConfig({ WEBSITE_CACHE_FRESHNESS_DAYS: "0" })).toEqual({ freshnessDays: 0 });
      expect(readWebsiteCacheConfig({ WEBSITE_CACHE_FRESHNESS_DAYS: "365" })).toEqual({ freshnessDays: 365 });
      for (const value of ["-1", "366", "abc", "1.5", "7days", "1e2"]) {
        expect(() => readWebsiteCacheConfig({ WEBSITE_CACHE_FRESHNESS_DAYS: value }), value).toThrow(WebsiteCacheConfigError);
        expect(() => readWebsiteCacheConfig({ WEBSITE_CACHE_FRESHNESS_DAYS: value })).toThrow(/WEBSITE_CACHE_FRESHNESS_DAYS$/);
      }
    });
  });

  describe("serving a fresh site from the cache", () => {
    it("crawls a site never crawled, then serves the second request from the stored pages with no fetch and no budget reserved", async () => {
      const runner = runnerWith(14);
      const first = crawl(runner);
      const firstResult = await first.result;
      expect(firstResult).toMatchObject({ servedFromCache: false, contentChanged: true });
      expect(first.plan).toHaveBeenCalledTimes(1);
      expect(first.fetcher).toHaveBeenCalledTimes(2);
      const afterFirst = await organization();
      expect(afterFirst.lastCrawledAt).not.toBeNull();
      expect(afterFirst.websiteContentHash).toBe(combinedContentHash(firstResult.pages));
      expect(afterFirst.websiteContentChanged).toBe(true);
      const reserved = await ledgerRows();
      expect(reserved).toBe(3); // one plan and two page fetches

      const second = crawl(runner);
      const secondResult = await second.result;
      expect(secondResult.servedFromCache).toBe(true);
      expect(second.plan).not.toHaveBeenCalled();
      expect(second.fetcher).not.toHaveBeenCalled();
      expect(await ledgerRows()).toBe(reserved);
      expect(secondResult.pages.map((page) => [page.url, page.text, page.method])).toEqual(firstResult.pages.map((page) => [page.url, page.text, page.method]));
      const run = await database.crawlRun.findUniqueOrThrow({ where: { id: secondResult.runId } });
      expect(run).toMatchObject({ status: "SUCCEEDED", servedFromCache: true, cacheSourceRunId: firstResult.runId });
      expect((await organization()).lastCrawledAt?.getTime()).toBe(afterFirst.lastCrawledAt?.getTime());
      // The hit created no new stored pages.
      expect(await database.source.count({ where: { organizationId } })).toBe(2);
    });

    it("crawls again when the period has expired and when the cache is turned off", async () => {
      const runner = runnerWith(14);
      await crawl(runner).result;
      await database.organization.update({ where: { id: organizationId }, data: { lastCrawledAt: new Date(Date.now() - 15 * DAY_MS) } });
      const expired = crawl(runner);
      expect((await expired.result).servedFromCache).toBe(false);
      expect(expired.fetcher).toHaveBeenCalledTimes(2);

      const off = crawl(runnerWith(0));
      expect((await off.result).servedFromCache).toBe(false);
      expect(off.fetcher).toHaveBeenCalledTimes(2);
    });

    it("crawls again on an explicit forced refresh", async () => {
      const runner = runnerWith(14);
      await crawl(runner).result;
      const forced = crawl(runner, { forceRefresh: true });
      expect((await forced.result).servedFromCache).toBe(false);
      expect(forced.fetcher).toHaveBeenCalledTimes(2);
      expect(await database.source.count({ where: { organizationId } })).toBe(4);
    });

    it("treats a different site for the same organization as a miss", async () => {
      const runner = runnerWith(14);
      await crawl(runner).result;
      const other = crawl(runner, { site: "https://other-site.example" });
      expect((await other.result).servedFromCache).toBe(false);
      expect(other.fetcher).toHaveBeenCalledTimes(2);
    });

    it("does not refresh the cache when a crawl fails", async () => {
      const runner = runnerWith(14);
      await crawl(runner).result;
      const stale = new Date(Date.now() - 20 * DAY_MS);
      await database.organization.update({ where: { id: organizationId }, data: { lastCrawledAt: stale } });
      const hashBefore = (await organization()).websiteContentHash;

      const failing = crawl(runner, { failPages: true });
      const result = await failing.result;
      expect(result.pages).toHaveLength(0);
      const after = await organization();
      expect(after.lastCrawledAt?.getTime()).toBe(stale.getTime());
      expect(after.websiteContentHash).toBe(hashBefore);
      expect((await database.crawlRun.findUniqueOrThrow({ where: { id: result.runId } })).status).toBe("FAILED");
    });

    it("never reads or writes the cache for a campaign that is not running", async () => {
      const runner = runnerWith(14);
      await crawl(runner).result; // a fresh cache exists
      const before = await organization();
      const stopped = await campaign("STOPPED");
      const attempt = { plan: vi.fn(), fetcher: vi.fn() };
      const failure = await runWithCorrelation(
        "trace-cache-stopped",
        () => {
          bindCampaign(stopped.id);
          return runner.run(organizationId, SITE, attempt.plan, attempt.fetcher);
        },
        {},
      ).catch((error: unknown) => error);
      // Not served from the fresh cache: the stopped campaign is refused by the gateway instead.
      expect(classifyProviderError(failure)).toMatchObject({ code: "CAMPAIGN_NOT_ACTIVE" });
      expect(attempt.plan).not.toHaveBeenCalled();
      expect(attempt.fetcher).not.toHaveBeenCalled();
      const after = await organization();
      expect(after.lastCrawledAt?.getTime()).toBe(before.lastCrawledAt?.getTime());
      expect(after.websiteContentHash).toBe(before.websiteContentHash);
      expect(await database.crawlRun.count({ where: { organizationId, servedFromCache: true } })).toBe(0);
    });

    it("serves the cache for a running campaign", async () => {
      const runner = runnerWith(14);
      await crawl(runner).result;
      const running = await campaign("RUNNING");
      const hit = { plan: vi.fn(), fetcher: vi.fn() };
      const result = await runWithCorrelation(
        "trace-cache-running",
        () => {
          bindCampaign(running.id);
          return runner.run(organizationId, SITE, hit.plan, hit.fetcher);
        },
        {},
      );
      expect(result.servedFromCache).toBe(true);
      expect(hit.fetcher).not.toHaveBeenCalled();
    });
  });

  describe("recording whether the content changed", () => {
    it("records unchanged content for the same pages and changed content for different text", async () => {
      const runner = runnerWith(14);
      const first = await crawl(runner).result;
      const again = await crawl(runner, { forceRefresh: true }).result;
      expect(again.contentChanged).toBe(false);
      expect(combinedContentHash(again.pages)).toBe(combinedContentHash(first.pages));
      expect((await organization()).websiteContentChanged).toBe(false);

      text = "We now also offer drone survey and bathymetric mapping services.";
      const changed = await crawl(runner, { forceRefresh: true }).result;
      expect(changed.contentChanged).toBe(true);
      expect(combinedContentHash(changed.pages)).not.toBe(combinedContentHash(first.pages));
      expect(await organization()).toMatchObject({ websiteContentChanged: true, websiteContentHash: combinedContentHash(changed.pages) });
    });

    it("gives one hash for the same pages in any order and a different one for different text or pages", () => {
      const a = { url: "https://x.test/a", httpStatus: 200, method: "HTTP" as const, title: "A", text: "alpha" };
      const b = { url: "https://x.test/b", httpStatus: 200, method: "HTTP" as const, title: "B", text: "beta" };
      expect(combinedContentHash([a, b])).toBe(combinedContentHash([b, a]));
      expect(combinedContentHash([a, b])).not.toBe(combinedContentHash([a, { ...b, text: "gamma" }]));
      expect(combinedContentHash([a, b])).not.toBe(combinedContentHash([a]));
    });
  });

  describe("reusing research for unchanged content, through the research path", () => {
    it("reuses the earlier claim extraction run without a provider call when the same pages are crawled again, and extracts again when they change", async () => {
      const extract = vi.fn().mockImplementation(() =>
        Promise.resolve({
          data: { claims: [], companyFitObservations: [] },
          model: "test-research-model",
          providerResponseId: `resp-${randomUUID()}`,
          prompt: { name: "company-claim-extraction", version: "v3" },
          usage: null,
        }),
      );
      const research = new ClaimExtractionService(
        databaseService,
        { getConfiguration: () => ({ provider: "openai", model: "test-research-model", prompt: { name: "company-claim-extraction", version: "v3" } }), extract } as never,
        new CompanyFitEvidenceService(databaseService),
        gateway,
      );
      const runner = runnerWith(14);
      const extractionRuns = () => database.claimExtractionRun.count({ where: { organizationId } });
      const extractionCalls = () => database.providerUsage.count({ where: { operation: "claim-extraction" } });

      await crawl(runner).result;
      await research.researchOrganization(organizationId);
      expect(extract).toHaveBeenCalledTimes(1);
      const callsAfterFirst = await extractionCalls();

      // The same pages crawled again create new stored pages, but the document set is the same.
      await crawl(runner, { forceRefresh: true }).result;
      expect(await database.source.count({ where: { organizationId } })).toBe(4);
      const reused = await research.researchOrganization(organizationId);
      expect(extract).toHaveBeenCalledTimes(1);
      expect(reused).toMatchObject({ extraction: { cached: true } });
      expect(await extractionRuns()).toBe(1);
      expect(await extractionCalls()).toBe(callsAfterFirst);

      // Different content is a different document set, so the provider is called again.
      text = "A different description of the company after a redesign of the website.";
      await crawl(runner, { forceRefresh: true }).result;
      await research.researchOrganization(organizationId);
      expect(extract).toHaveBeenCalledTimes(2);
      expect(await extractionRuns()).toBe(2);
    });
  });
});
