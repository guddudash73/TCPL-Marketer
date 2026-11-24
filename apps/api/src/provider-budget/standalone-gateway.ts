import type { PrismaClient } from "@tcpl-marketer/database";

import { AuditService } from "../audit/audit.service.js";
import { ProviderCallAuditor } from "../audit/provider-call-auditor.service.js";
import { CrawlRunner } from "../crawler/crawl-runner.js";
import { readWebsiteCacheConfig } from "../crawler/website-cache.config.js";
import type { DatabaseService } from "../database/database.service.js";
import { CampaignProviderCallGuard } from "./provider-call-guard.js";
import { readProviderBudgetConfig } from "./provider-budget.config.js";
import { ProviderUsageLedger } from "./provider-usage-ledger.service.js";

/**
 * The same gateway the application uses, built from a database client for the
 * manual live scripts that run outside NestJS (PH1-03c). A live script therefore
 * spends against the same caps and leaves the same ledger and audit rows as the
 * running application. It needs DATABASE_URL and the budget variables of .env.
 */
export function createStandaloneGateway(client: PrismaClient, environment: NodeJS.ProcessEnv = process.env): ProviderCallAuditor {
  const database = { client } as unknown as DatabaseService;
  return new ProviderCallAuditor(
    new AuditService(database),
    new ProviderUsageLedger(database, readProviderBudgetConfig(environment)),
    new CampaignProviderCallGuard(database),
  );
}

/** A crawl runner for manual live scripts, with the same gateway, campaign guard and website cache as the application. */
export function createStandaloneCrawlRunner(client: PrismaClient, environment: NodeJS.ProcessEnv = process.env): CrawlRunner {
  return new CrawlRunner(
    { client } as unknown as DatabaseService,
    createStandaloneGateway(client, environment),
    new CampaignProviderCallGuard({ client } as unknown as DatabaseService),
    readWebsiteCacheConfig(environment),
  );
}
