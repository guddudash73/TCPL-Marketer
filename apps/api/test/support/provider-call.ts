import type { ProviderCallContext } from "@tcpl-marketer/provider-contracts";

import { CrawlRunner } from "../../src/crawler/crawl-runner.js";
import type { DatabaseService } from "../../src/database/database.service.js";
import { issueProviderCallContext } from "../../src/provider-budget/provider-call-context.js";

/** A gateway-issued context for tests that exercise an adapter directly. */
export function testCall(provider: string, operation = "test"): ProviderCallContext {
  return issueProviderCallContext(provider, operation);
}

/**
 * A gateway stand-in that runs the work with an issued context and records nothing.
 * Only for unit tests of code that is not the subject of a budget test.
 */
export function passthroughGateway(provider = "openai") {
  return {
    run: <T>(call: { provider?: string; operation: string }, work: (context: ReturnType<typeof issueProviderCallContext>) => Promise<T>): Promise<T> =>
      work(issueProviderCallContext(call.provider ?? provider, call.operation)),
  } as never;
}

/** A crawl runner with the website cache off, for tests that crawl the same site more than once. */
export function testCrawlRunner(database: DatabaseService, gateway: ReturnType<typeof passthroughGateway> = passthroughGateway("crawl"), freshnessDays = 0): CrawlRunner {
  return new CrawlRunner(database, gateway, { check: () => Promise.resolve(null) }, { freshnessDays });
}
