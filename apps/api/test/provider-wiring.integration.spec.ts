import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@tcpl-marketer/database";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditService } from "../src/audit/audit.service.js";
import { ProviderCallAuditor } from "../src/audit/provider-call-auditor.service.js";
import { HttpExceptionFilter } from "../src/common/http-exception.filter.js";
import { bindCampaign, runWithCorrelation } from "../src/common/correlation/correlation-context.js";
import type { DatabaseService } from "../src/database/database.service.js";
import { ApolloPeopleSearchAdapter } from "../src/people/apollo-people-search.adapter.js";
import { PeopleSelectionWorkflowService } from "../src/people/people-selection-workflow.service.js";
import { PublicPeopleSearchAdapter } from "../src/people/public-people-search.adapter.js";
import { readProviderBudgetConfig } from "../src/provider-budget/provider-budget.config.js";
import { CampaignProviderCallGuard } from "../src/provider-budget/provider-call-guard.js";
import { ProviderBypassError } from "../src/provider-budget/provider-call-context.js";
import { classifyProviderError } from "../src/provider-budget/provider-outcome.js";
import { createStandaloneGateway } from "../src/provider-budget/standalone-gateway.js";
import { ProviderUsageLedger } from "../src/provider-budget/provider-usage-ledger.service.js";
import { TEST_BUDGET_ENV } from "./support/budget-env.js";
import { testCall, testCrawlRunner } from "./support/provider-call.js";

// Private database per file: the dev database and other files' rows are never touched.
const baseUrl = process.env.DATABASE_URL ?? "postgresql://app:app@localhost:5432/tcpl_marketer";
const databaseName = `tcpl_test_wiring_${randomUUID().replaceAll("-", "")}`;
const privateUrl = new URL(baseUrl);
privateUrl.pathname = `/${databaseName}`;
const environmentKeys = ["DATABASE_URL", "DIRECT_URL", "OPENAI_API_KEY", "OPENAI_RESEARCH_MODEL", "APOLLO_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

function environment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...TEST_BUDGET_ENV,
    OPENAI_PRICE_INPUT_PER_MILLION_USD: "2.5",
    OPENAI_PRICE_OUTPUT_PER_MILLION_USD: "10",
    OPENAI_WEB_SEARCH_FEE_USD: "0.01",
    ...overrides,
  };
}

const peopleInput = {
  organization: { id: randomUUID(), name: "Example Surveying", domain: "example.test", location: "Colorado" },
  roles: [
    { decisionMakerProfileId: randomUUID(), title: "Survey Director", priority: 1, seniorities: ["Director"], positiveTerms: [], negativeTerms: [] },
  ],
  maximumResults: 5,
};

/** Runs a handler through the real exception filter and returns what the caller would see. */
function answer(error: unknown) {
  const filter = new HttpExceptionFilter({ error: vi.fn(), warn: vi.fn() } as never);
  const response = { headers: {} as Record<string, string>, status: 0, body: {} as Record<string, unknown> };
  const reply = {
    setHeader: (name: string, value: string) => { response.headers[name] = value; },
    status: (code: number) => { response.status = code; return reply; },
    json: (body: object) => { response.body = body as Record<string, unknown>; },
  };
  filter.catch(error, { switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({ id: "r", method: "POST", url: "/internal/x" }) }) } as never);
  return response;
}

describe("people, Apollo and crawl behind the provider gateway (private PostgreSQL database)", () => {
  const admin = createPrismaClient(baseUrl);
  let database: ReturnType<typeof createPrismaClient>;
  let databaseService: DatabaseService;
  let userId = "";
  let sectorId = "";

  const gatewayFor = (overrides: Record<string, string> = {}) => {
    const ledger = new ProviderUsageLedger(databaseService, readProviderBudgetConfig(environment(overrides)));
    return { ledger, gateway: new ProviderCallAuditor(new AuditService(databaseService), ledger, new CampaignProviderCallGuard(databaseService)) };
  };

  async function campaign(status: "RUNNING" | "STOPPED" = "RUNNING") {
    return database.campaign.create({
      data: { name: `PH1-03c ${randomUUID()}`, sectorId, createdByUserId: userId, status, researchDepth: "STANDARD", targetLeadCount: 3, minimumScore: 70, dailyEmailLimit: 10 },
    });
  }

  const apolloOk = () => vi.fn().mockResolvedValue(new Response(JSON.stringify({ people: [] }), { status: 200 }));
  const apolloStatus = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers }));
  const publicParse = (people: unknown[] = []) =>
    vi.fn().mockResolvedValue({
      id: "resp-people",
      model: "test-research-model",
      output_parsed: { people },
      output: [
        { type: "web_search_call", action: { type: "search", sources: [{ url: "https://example.test/team" }] } },
        { type: "web_search_call", action: { type: "open_page", url: "https://example.test/team" } },
        { type: "web_search_call", action: { type: "search", sources: [{ url: "https://example.test/about" }] } },
      ],
      usage: { input_tokens: 1000, output_tokens: 500, total_tokens: 1500 },
    });

  beforeAll(async () => {
    for (const name of environmentKeys) saved[name] = process.env[name];
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    process.env.DATABASE_URL = privateUrl.toString();
    process.env.DIRECT_URL = privateUrl.toString();
    process.env.OPENAI_API_KEY = "sk-wiring-test-key-not-real";
    process.env.OPENAI_RESEARCH_MODEL = "test-research-model";
    process.env.APOLLO_API_KEY = "apollo-wiring-test-key";
    execSync("pnpm --filter @tcpl-marketer/database exec prisma migrate deploy", { env: process.env, stdio: "ignore" });
    database = createPrismaClient(privateUrl.toString());
    databaseService = { client: database } as unknown as DatabaseService;
    userId = (await database.user.create({ data: { email: `ph103c-${randomUUID()}@example.test`, passwordHash: "unused" } })).id;
    sectorId = (await database.sector.create({ data: { name: "PH1-03c sector", slug: `ph103c-${randomUUID()}` } })).id;
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
    await database.$executeRawUnsafe("DELETE FROM provider_usage");
    await database.auditLog.deleteMany({});
  });

  describe("every adapter refuses a call that did not come from the gateway", () => {
    it("throws ProviderBypassError without a gateway-issued context, and for a context issued for another provider", async () => {
      const apollo = new ApolloPeopleSearchAdapter(apolloOk() as unknown as typeof fetch);
      const people = new PublicPeopleSearchAdapter({ responses: { parse: publicParse() } } as never);
      const forged = { provider: "apollo", operation: "people-search", recordRequest: () => undefined };
      for (const call of [undefined, {}, forged, testCall("openai", "people-search")]) {
        await expect(apollo.searchPeople(peopleInput, call as never)).rejects.toBeInstanceOf(ProviderBypassError);
      }
      await expect(people.searchPeople(peopleInput, testCall("apollo", "x"))).rejects.toBeInstanceOf(ProviderBypassError);
      await expect(people.searchPeople(peopleInput, undefined as never)).rejects.toBeInstanceOf(ProviderBypassError);
    });
  });

  describe("people search through the gateway", () => {
    it("settles the public search at its known cost, pricing only billed searches, and Apollo at 0 credits", async () => {
      const { gateway, ledger } = gatewayFor();
      const owner = await campaign();
      const publicSearch = new PublicPeopleSearchAdapter({ responses: { parse: publicParse() } } as never);
      const apollo = new ApolloPeopleSearchAdapter(apolloOk() as unknown as typeof fetch);

      const first = await gateway.run({ provider: "openai", operation: "people-web-search", campaignId: owner.id }, (call) => publicSearch.searchPeople(peopleInput, call));
      expect(first.usage).toMatchObject({ requests: 1, webSearchCalls: 2, inputTokens: 1000, outputTokens: 500 });
      const second = await gateway.run({ provider: "apollo", operation: "people-search", campaignId: owner.id }, (call) => apollo.searchPeople(peopleInput, call));
      expect(second.usage).toEqual({ requests: 1, credits: 0 });

      const rows = await database.providerUsage.findMany({ where: { campaignId: owner.id }, orderBy: { reservedAt: "asc" } });
      // 1000 input tokens (0.0025) + 500 output tokens (0.005) + 2 billed searches (0.02); the open_page action is free.
      expect(rows[0]).toMatchObject({ provider: "openai", status: "SETTLED", costKnown: true });
      expect(rows[0]?.actualAmount?.toString()).toBe("0.0275");
      expect(rows[1]).toMatchObject({ provider: "apollo", status: "SETTLED", costKnown: true, unit: "CREDITS" });
      expect(rows[1]?.actualAmount?.toString()).toBe("0");
      expect((await ledger.totals({ campaignId: owner.id })).map((row) => row.provider)).toEqual(["apollo", "openai"]);
    });

    it("maps an Apollo rate limit, credit exhaustion, timeout and permission error without throwing past the gateway's contract", async () => {
      const { gateway, ledger } = gatewayFor();
      const owner = await campaign();
      const run = (fetchStub: ReturnType<typeof vi.fn>) =>
        gateway
          .run({ provider: "apollo", operation: "people-search", campaignId: owner.id }, (call) =>
            new ApolloPeopleSearchAdapter(fetchStub as unknown as typeof fetch).searchPeople(peopleInput, call),
          )
          .catch((error: unknown) => error);

      // Rate limit: 429 with Apollo's retry-after header and error code.
      const limited = await run(apolloStatus(429, { error_details: { code: "USAGE.RATE_LIMIT.API_RATE_LIMIT_EXCEEDED" } }, { "retry-after": "42" }));
      expect(classifyProviderError(limited)).toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfterSeconds: 42 });
      expect(answer(limited)).toMatchObject({ status: 429, headers: { "Retry-After": "42" } });

      // Credit exhaustion: status 402 (Apollo does not document one; the mapper accepts it defensively).
      const credit = await run(apolloStatus(402, { error: "payment required" }));
      expect(classifyProviderError(credit)).toMatchObject({ code: "CREDIT_EXHAUSTED", retryable: false });
      expect(answer(credit).status).toBe(402);

      // Timeout: the adapter's own AbortSignal.timeout error.
      const timeout = await run(vi.fn().mockRejectedValue(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" })));
      expect(classifyProviderError(timeout)).toMatchObject({ code: "TIMEOUT", retryable: true });
      expect(answer(timeout).status).toBe(504);

      // A permission error keeps its existing handling: it is not an exhaustion outcome.
      const denied = await run(apolloStatus(403, { error: "not authorized" }));
      expect(classifyProviderError(denied)).toBeNull();

      // No call charged anything: 4xx answers were released, the timeout is held at its estimate as unknown.
      const rows = await database.providerUsage.findMany({ where: { campaignId: owner.id }, orderBy: { reservedAt: "asc" } });
      expect(rows.map((row) => row.status)).toEqual(["RELEASED", "RELEASED", "SETTLED", "RELEASED"]);
      expect(rows[2]?.costKnown).toBe(false);
      expect((await ledger.totals({ campaignId: owner.id }))[0]?.unknownCostCalls).toBe(1);
    });

    function workflowWith(gateway: ProviderCallAuditor, parts: { parse: ReturnType<typeof vi.fn>; apollo: ReturnType<typeof vi.fn>; campaignId: string }) {
      const persist = vi.fn();
      const assign = vi.fn().mockResolvedValue({ selected: [] });
      const fakeDatabase = {
        client: {
          acceptanceDiagnosticRun: { findUnique: vi.fn().mockResolvedValue(null) },
          leadCandidate: {
            findUnique: vi.fn().mockResolvedValue({
              updatedAt: new Date(),
              status: "QUALIFIED",
              campaignId: parts.campaignId,
              scores: [{ qualified: true }],
              organization: { id: peopleInput.organization.id, name: "Example Surveying", normalizedDomain: "example.test", location: "Colorado" },
              campaign: {
                capabilities: [
                  {
                    capability: {
                      decisionMakers: [{ id: peopleInput.roles[0]!.decisionMakerProfileId, title: "Survey Director", priority: 1, seniorities: ["Director"], positiveTerms: [], negativeTerms: [] }],
                    },
                  },
                ],
              },
            }),
          },
        },
      } as unknown as DatabaseService;
      const service = new PeopleSelectionWorkflowService(
        fakeDatabase,
        new PublicPeopleSearchAdapter({ responses: { parse: parts.parse } } as never),
        new ApolloPeopleSearchAdapter(parts.apollo as unknown as typeof fetch),
        { persistCandidate: persist } as never,
        { assign } as never,
        gateway,
      );
      return { service, persist, assign };
    }

    it("counts both searches toward the campaign and its run, and keeps ordinary provider failures as warnings", async () => {
      const { gateway } = gatewayFor();
      const owner = await campaign();
      const start = await database.outboxEvent.create({
        data: { eventType: "CAMPAIGN_STARTED", aggregateType: "campaign", aggregateId: owner.id, idempotencyKey: `campaign-start:${owner.id}`, payload: { campaignId: owner.id } },
      });
      const { service } = workflowWith(gateway, {
        parse: publicParse(),
        apollo: apolloStatus(500, { error: `server error for key ${process.env.APOLLO_API_KEY}` }),
        campaignId: owner.id,
      });
      const result = (await runWithCorrelation("trace-people-0001", () => service.selectDecisionMakers(randomUUID()))) as { discovery: { warnings: string[] } };
      expect(result.discovery.warnings.some((warning) => warning.startsWith("Apollo discovery unavailable"))).toBe(true);
      // The warning is returned to the caller, so a key echoed by the provider must not appear in it.
      expect(JSON.stringify(result)).not.toContain(process.env.APOLLO_API_KEY as string);

      const rows = await database.providerUsage.findMany({ where: { campaignId: owner.id }, orderBy: { reservedAt: "asc" } });
      expect(rows.map((row) => [row.provider, row.operation, row.runId])).toEqual([
        ["openai", "people-web-search", start.id],
        ["apollo", "people-search", start.id],
      ]);
    });

    it("stops with the mapped outcome instead of selecting people from a partial search, and persists nothing", async () => {
      const owner = await campaign();
      const cases: Array<[string, Record<string, string>, ReturnType<typeof vi.fn>, string]> = [
        ["budget exhausted", { BUDGET_OPENAI_DAY_USD: "0.01" }, apolloOk(), "BUDGET_EXHAUSTED"],
        ["Apollo rate limited", {}, apolloStatus(429, {}, { "retry-after": "9" }), "RATE_LIMITED"],
        ["Apollo timeout", {}, vi.fn().mockRejectedValue(Object.assign(new Error("slow"), { name: "TimeoutError" })), "TIMEOUT"],
        ["Apollo credit exhausted", {}, apolloStatus(402, {}), "CREDIT_EXHAUSTED"],
      ];
      for (const [, overrides, apollo, code] of cases) {
        await database.$executeRawUnsafe("DELETE FROM provider_usage");
        const { gateway } = gatewayFor(overrides);
        const parse = publicParse();
        const { service, persist, assign } = workflowWith(gateway, { parse, apollo, campaignId: owner.id });
        const failure = await service.selectDecisionMakers(randomUUID()).catch((error: unknown) => error);
        expect(classifyProviderError(failure), code).toMatchObject({ code });
        expect(persist).not.toHaveBeenCalled();
        expect(assign).not.toHaveBeenCalled();
        if (code === "BUDGET_EXHAUSTED") expect(parse).not.toHaveBeenCalled();
      }
    });

    it("refuses both searches for a stopped campaign before any budget is reserved", async () => {
      const { gateway } = gatewayFor();
      const owner = await campaign("STOPPED");
      const parse = publicParse();
      const apollo = apolloOk();
      const { service } = workflowWith(gateway, { parse, apollo, campaignId: owner.id });
      const failure = await service.selectDecisionMakers(randomUUID()).catch((error: unknown) => error);
      expect(classifyProviderError(failure)).toMatchObject({ code: "CAMPAIGN_NOT_ACTIVE", httpStatus: 409 });
      expect(parse).not.toHaveBeenCalled();
      expect(apollo).not.toHaveBeenCalled();
      expect(await database.providerUsage.count()).toBe(0);
    });

    it("fails closed for Apollo when its caps or credit price are missing", async () => {
      const env = environment();
      delete env.APOLLO_USD_PER_CREDIT;
      const ledger = new ProviderUsageLedger(databaseService, readProviderBudgetConfig(env));
      const gateway = new ProviderCallAuditor(new AuditService(databaseService), ledger, new CampaignProviderCallGuard(databaseService));
      const apollo = apolloOk();
      const failure = await gateway
        .run({ provider: "apollo", operation: "people-search" }, (call) => new ApolloPeopleSearchAdapter(apollo as unknown as typeof fetch).searchPeople(peopleInput, call))
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ code: "CAP_NOT_CONFIGURED" });
      expect(apollo).not.toHaveBeenCalled();
    });
  });

  describe("crawl through the gateway", () => {
    let organizationId = "";
    const plan = (urls: string[] = []) => ({ homepageUrl: "https://crawl.test/", robotsUrl: "https://crawl.test/robots.txt", sitemapUrls: [], pageUrls: urls });
    const page = { url: "https://crawl.test/", httpStatus: 200, method: "HTTP" as const, title: "Home", text: "Content" };

    beforeEach(async () => {
      organizationId = (await database.organization.create({
        data: { name: "Crawl wiring", normalizedName: `crawl-wiring-${randomUUID()}`, location: "Test", normalizedLocation: "test" },
      })).id;
    });

    const runner = (overrides: Record<string, string> = {}) => testCrawlRunner(databaseService, gatewayFor(overrides).gateway as never);

    it("counts every outbound request of a crawl plan and of a page fetch in the ledger", async () => {
      const owner = await campaign();
      const result = await runWithCorrelation(
        "trace-crawl-0001",
        async () => {
          bindCampaign(owner.id);
          return runner().run(
            organizationId,
            "https://crawl.test",
            // The planner reads robots.txt and a sitemap; both private reads are refused by the SSRF controls after being counted.
            async (_url, read) => {
              await read!("http://127.0.0.1/robots.txt").catch(() => undefined);
              await read!("http://10.0.0.1/sitemap.xml").catch(() => undefined);
              return plan(["https://crawl.test/"]);
            },
            async (_url, read) => {
              await read!("http://127.0.0.1/").catch(() => undefined);
              return page;
            },
          );
        },
        {},
      );
      expect(result.pages).toHaveLength(1);
      const rows = await database.providerUsage.findMany({ where: { provider: "crawl" }, orderBy: { reservedAt: "asc" } });
      expect(rows.map((row) => [row.operation, row.status, row.requests, row.costKnown])).toEqual([
        ["crawl-plan", "SETTLED", 2, true],
        ["page-fetch", "SETTLED", 1, true],
      ]);
      expect(rows[0]?.campaignId).toBe(owner.id);
      expect(rows[0]?.actualAmount?.toString()).toBe("2");
    });

    it("stops the crawl on an exhausted budget, keeps stored pages, calls no fetcher past the cap and marks the run failed with the reason", async () => {
      const fetcher = vi.fn().mockResolvedValue(page);
      // One request in total: the plan uses it, so the first page fetch is refused.
      const failure = await runner({ BUDGET_CRAWL_DAY_REQUESTS: "1" })
        .run(organizationId, "https://crawl.test", async () => plan(["https://crawl.test/", "https://crawl.test/about"]), fetcher)
        .catch((error: unknown) => error);
      expect(classifyProviderError(failure)).toMatchObject({ code: "BUDGET_EXHAUSTED" });
      expect(fetcher).not.toHaveBeenCalled();
      const run = await database.crawlRun.findFirstOrThrow({ where: { organizationId } });
      expect(run.status).toBe("FAILED");
      expect(await database.crawlAttempt.count({ where: { crawlRunId: run.id } })).toBe(0);
    });

    it("limits crawl requests per minute, and reports a timeout as a retryable outcome instead of a failed page", async () => {
      const limited = await runner({ PROVIDER_RATE_CRAWL_PER_MINUTE: "1" })
        .run(organizationId, "https://crawl.test", async () => plan(["https://crawl.test/"]), vi.fn().mockResolvedValue(page))
        .catch((error: unknown) => error);
      expect(classifyProviderError(limited)).toMatchObject({ code: "RATE_LIMITED", retryable: true });

      await database.$executeRawUnsafe("DELETE FROM provider_usage");
      const slow = vi.fn().mockRejectedValue(Object.assign(new Error("slow"), { name: "TimeoutError" }));
      const timedOut = await runner()
        .run(organizationId, "https://crawl.test", async () => plan(["https://crawl.test/"]), slow)
        .catch((error: unknown) => error);
      expect(classifyProviderError(timedOut)).toMatchObject({ code: "TIMEOUT", retryable: true });
      const run = await database.crawlRun.findFirstOrThrow({ where: { organizationId }, orderBy: { startedAt: "desc" } });
      expect(await database.crawlAttempt.count({ where: { crawlRunId: run.id } })).toBe(0);
    });

    it("still records an ordinary page failure as a failed attempt and finishes the run", async () => {
      const fetcher = vi.fn().mockRejectedValueOnce(new Error("Page missing")).mockResolvedValueOnce(page);
      const result = await runner().run(organizationId, "https://crawl.test", async () => plan(["https://crawl.test/missing", "https://crawl.test/"]), fetcher);
      expect(result.pages).toHaveLength(1);
      const run = await database.crawlRun.findFirstOrThrow({ where: { organizationId } });
      expect(run.status).toBe("SUCCEEDED");
      expect(await database.crawlAttempt.count({ where: { crawlRunId: run.id, status: "FAILED" } })).toBe(1);
    });
  });

  describe("manual live scripts use the same gateway", () => {
    it("builds the standalone gateway from the environment, spends against the same ledger and refuses to build without caps", async () => {
      const gateway = createStandaloneGateway(database, environment());
      await gateway.run({ provider: "openai", operation: "search-plan" }, () => Promise.resolve({ usage: { inputTokens: 1000, outputTokens: 500 } }));
      const row = await database.providerUsage.findFirstOrThrow();
      expect(row).toMatchObject({ provider: "openai", status: "SETTLED", costKnown: true });

      const incomplete = environment({ OPENAI_API_KEY: "sk-present" });
      delete incomplete.BUDGET_OPENAI_DAY_USD;
      expect(() => createStandaloneGateway(database, incomplete)).toThrow(/BUDGET_OPENAI_DAY_USD/);
    });
  });

  describe("secrets echoed by Apollo and the public people search", () => {
    it("never reach a response, a log line, an audit row or a ledger row", async () => {
      // The configured key is what a provider can echo back; the redactor knows it by value.
      const secret = process.env.APOLLO_API_KEY as string;
      const bearer = "Ph103cBearerTokenAbCdEfGhIjKlMn";
      const { gateway } = gatewayFor();
      const owner = await campaign();
      const echoBody = { error: `Invalid key ${secret}`, authorization: `Bearer ${bearer}` };
      const logged: unknown[] = [];
      const filter = new HttpExceptionFilter({ error: (...a: unknown[]) => logged.push(a), warn: (...a: unknown[]) => logged.push(a) } as never);
      const responses: unknown[] = [];
      const reply = (response: { headers: Record<string, string>; status: number; body: unknown }) => ({
        setHeader: (name: string, value: string) => { response.headers[name] = value; },
        status: (code: number) => { response.status = code; return reply(response); },
        json: (body: object) => { response.body = body; },
      });
      const sites: Array<[string, string, (call: ReturnType<typeof testCall>) => Promise<unknown>]> = [
        ["apollo", "people-search", (call) => new ApolloPeopleSearchAdapter(apolloStatus(401, echoBody) as unknown as typeof fetch).searchPeople(peopleInput, call)],
        [
          "openai",
          "people-web-search",
          (call) =>
            new PublicPeopleSearchAdapter({
              responses: { parse: vi.fn().mockRejectedValue(Object.assign(new Error(`Incorrect API key ${secret}. Authorization: Bearer ${bearer}`), { status: 401 })) },
            } as never).searchPeople(peopleInput, call),
        ],
      ];
      for (const [provider, operation, work] of sites) {
        const failure = await gateway.run({ provider, operation, campaignId: owner.id }, work).catch((error: unknown) => error);
        const response = { headers: {} as Record<string, string>, status: 0, body: undefined as unknown };
        filter.catch(failure, { switchToHttp: () => ({ getResponse: () => reply(response), getRequest: () => ({ id: "r", method: "POST", url: "/internal/x" }) }) } as never);
        responses.push(response);
      }
      const everything = JSON.stringify([responses, logged, await database.auditLog.findMany(), await database.providerUsage.findMany()]);
      for (const value of [secret, bearer]) expect(everything).not.toContain(value);
    });
  });
});
