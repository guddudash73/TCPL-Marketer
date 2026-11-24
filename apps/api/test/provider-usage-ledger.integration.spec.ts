import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { NestFactory } from "@nestjs/core";
import { createPrismaClient } from "@tcpl-marketer/database";
import type { ProviderCallContext } from "@tcpl-marketer/provider-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AuditService } from "../src/audit/audit.service.js";
import { ProviderCallAuditor } from "../src/audit/provider-call-auditor.service.js";
import { createApp } from "../src/bootstrap.js";
import type { DatabaseService } from "../src/database/database.service.js";
import { PrismaCampaignStateReader } from "../src/orchestration/prisma-campaign-state-reader.js";
import { DiscoveryStageService } from "../src/orchestration/discovery-stage.service.js";
import { StageRunService } from "../src/orchestration/stage-run.service.js";
import { SearchService } from "../src/search/search.service.js";
import type { OrganizationResolutionService } from "../src/search/organization-resolution.service.js";
import { CampaignProviderCallGuard } from "../src/provider-budget/provider-call-guard.js";
import { OpenAIClaimExtractionAdapter } from "../src/company-intelligence/openai-claim-extraction.adapter.js";
import { HttpExceptionFilter } from "../src/common/http-exception.filter.js";
import { OpenAISearchAdapter } from "../src/search/openai-search.adapter.js";
import { runWithCorrelation } from "../src/common/correlation/correlation-context.js";
import { classifyProviderError } from "../src/provider-budget/provider-outcome.js";
import { ProviderBudgetModule } from "../src/provider-budget/provider-budget.module.js";
import { ProviderBudgetError } from "../src/provider-budget/provider-budget.error.js";
import {
  ProviderBudgetConfigError,
  readProviderBudgetConfig,
} from "../src/provider-budget/provider-budget.config.js";
import {
  ProviderLedgerError,
  ProviderUsageLedger,
  type ReserveDecision,
} from "../src/provider-budget/provider-usage-ledger.service.js";
import { TEST_BUDGET_ENV } from "./support/budget-env.js";

// Private database per file: the dev database and other files' rows are never touched.
const baseUrl = process.env.DATABASE_URL ?? "postgresql://app:app@localhost:5432/tcpl_marketer";
const databaseName = `tcpl_test_ledger_${randomUUID().replaceAll("-", "")}`;
const privateUrl = new URL(baseUrl);
privateUrl.pathname = `/${databaseName}`;
const environmentKeys = ["DATABASE_URL", "DIRECT_URL", "OPENAI_API_KEY", "APOLLO_API_KEY", "N8N_SERVICE_SECRET", "N8N_BASE_URL"] as const;
const saved: Record<string, string | undefined> = {};

/** Budget environment for one test: generous defaults plus the prices used in the cost tests. */
function environment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    ...TEST_BUDGET_ENV,
    OPENAI_PRICE_INPUT_PER_MILLION_USD: "2.5",
    OPENAI_PRICE_OUTPUT_PER_MILLION_USD: "10",
    OPENAI_WEB_SEARCH_FEE_USD: "0.01",
    ...overrides,
  };
}

describe("provider usage ledger (private PostgreSQL database)", () => {
  const admin = createPrismaClient(baseUrl);
  let database: ReturnType<typeof createPrismaClient>;
  let databaseService: DatabaseService;
  let userId = "";
  let sectorId = "";

  const ledgerFor = (overrides: Record<string, string> = {}, client = databaseService) =>
    new ProviderUsageLedger(client, readProviderBudgetConfig(environment(overrides)));

  async function campaign() {
    return database.campaign.create({
      data: {
        name: `PH1-03a ${randomUUID()}`,
        sectorId,
        createdByUserId: userId,
        status: "RUNNING",
        researchDepth: "STANDARD",
        targetLeadCount: 3,
        minimumScore: 70,
        dailyEmailLimit: 10,
      },
    });
  }

  const key = () => `k-${randomUUID()}`;
  const reserved = (decision: ReserveDecision) => {
    if (decision.status !== "RESERVED") throw new Error(`expected RESERVED, got ${decision.status}`);
    return decision.reservation;
  };

  beforeAll(async () => {
    for (const name of environmentKeys) saved[name] = process.env[name];
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    process.env.DATABASE_URL = privateUrl.toString();
    process.env.DIRECT_URL = privateUrl.toString();
    // Every migration applies to an empty database, which is itself part of the proof.
    execSync("pnpm --filter @tcpl-marketer/database exec prisma migrate deploy", { env: process.env, stdio: "ignore" });
    database = createPrismaClient(privateUrl.toString());
    databaseService = { client: database } as unknown as DatabaseService;
    userId = (await database.user.create({ data: { email: `ph103a-${randomUUID()}@example.test`, passwordHash: "unused" } })).id;
    sectorId = (await database.sector.create({ data: { name: "PH1-03a sector", slug: `ph103a-${randomUUID()}` } })).id;
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

  describe("configuration", () => {
    const paidKeys = { OPENAI_API_KEY: "present", APOLLO_API_KEY: "present" };

    it("accepts a complete configuration", () => {
      const config = readProviderBudgetConfig({ ...environment(), ...paidKeys });
      expect(config.providers.openai.missing).toEqual([]);
      expect(config.globalDayUsd).toBe(100_000_000_000n);
    });

    it("refuses to start when a configured paid provider has a missing, zero or non-numeric cap, naming the variable only", () => {
      for (const [name, value] of [
        ["BUDGET_OPENAI_DAY_USD", undefined],
        ["BUDGET_OPENAI_RUN_USD", "0"],
        ["BUDGET_OPENAI_CAMPAIGN_USD", "sk-secret-looking-value"],
        ["BUDGET_APOLLO_DAY_CREDITS", ""],
        ["BUDGET_GLOBAL_DAY_USD", "-5"],
        ["OPENAI_ESTIMATE_CALL_USD", undefined],
      ] as const) {
        const env: NodeJS.ProcessEnv = { ...environment(), ...paidKeys };
        if (value === undefined) delete env[name];
        else env[name] = value;
        let message = "";
        try {
          readProviderBudgetConfig(env);
        } catch (error) {
          expect(error).toBeInstanceOf(ProviderBudgetConfigError);
          message = (error as Error).message;
        }
        expect(message, name).toContain(name);
        expect(message).not.toContain("sk-secret-looking-value");
      }
    });

    it("does not refuse startup for a paid provider that is not configured, but its calls fail closed", async () => {
      const env = environment();
      delete env.BUDGET_OPENAI_DAY_USD;
      const config = readProviderBudgetConfig(env);
      expect(config.providers.openai.missing).toContain("BUDGET_OPENAI_DAY_USD");
      const ledger = new ProviderUsageLedger(databaseService, config);
      const decision = await ledger.reserve({ provider: "openai", operation: "search-plan", callKey: key() });
      expect(decision).toMatchObject({ status: "CAP_NOT_CONFIGURED", variables: ["BUDGET_OPENAI_DAY_USD"] });
      expect(await database.providerUsage.count()).toBe(0);
    });

    it("defaults the alert threshold to 80 percent and rejects an invalid one at startup", () => {
      expect(readProviderBudgetConfig(environment()).alertPercent).toBe(80);
      expect(readProviderBudgetConfig({ ...environment(), BUDGET_ALERT_PERCENT: "65" }).alertPercent).toBe(65);
      for (const value of ["0", "100", "abc", "-5", "80.5"]) {
        expect(() => readProviderBudgetConfig({ ...environment(), BUDGET_ALERT_PERCENT: value }), value).toThrow(/BUDGET_ALERT_PERCENT/);
      }
    });

    it("rejects invalid rate and concurrency settings at startup", () => {
      expect(() => readProviderBudgetConfig({ ...environment(), PROVIDER_RATE_OPENAI_PER_MINUTE: "0" })).toThrow(
        /PROVIDER_RATE_OPENAI_PER_MINUTE/,
      );
      expect(() => readProviderBudgetConfig({ ...environment(), PROVIDER_CONCURRENCY_APOLLO: "many" })).toThrow(
        /PROVIDER_CONCURRENCY_APOLLO/,
      );
    });
  });

  describe("atomic reservation against the caps", () => {
    it("refuses a call that would pass the run, campaign, day or global cap and names the scope", async () => {
      const owner = await campaign();
      const run = `run-${randomUUID()}`;
      const base = { provider: "openai", operation: "search-plan", campaignId: owner.id, runId: run };

      for (const [overrides, scope] of [
        [{ BUDGET_OPENAI_RUN_USD: "0.04" }, "RUN"],
        [{ BUDGET_OPENAI_CAMPAIGN_USD: "0.04" }, "CAMPAIGN"],
        [{ BUDGET_OPENAI_DAY_USD: "0.04" }, "DAY"],
        [{ BUDGET_GLOBAL_DAY_USD: "0.04" }, "GLOBAL_DAY"],
      ] as const) {
        const decision = await ledgerFor(overrides).reserve({ ...base, callKey: key() });
        expect(decision).toMatchObject({ status: "BUDGET_EXCEEDED", scope, requested: "0.050000" });
      }
      expect(await database.providerUsage.count()).toBe(0);
    });

    it("never exceeds a cap under 40 concurrent reservations from separate application instances", async () => {
      const second = createPrismaClient(privateUrl.toString());
      try {
        const instances = [
          ledgerFor({ BUDGET_OPENAI_DAY_USD: "0.25" }),
          ledgerFor({ BUDGET_OPENAI_DAY_USD: "0.25" }, { client: second } as unknown as DatabaseService),
        ];
        const owner = await campaign();
        const decisions = await Promise.all(
          Array.from({ length: 40 }, (_, index) =>
            instances[index % 2]!.reserve({ provider: "openai", operation: "search-plan", callKey: key(), campaignId: owner.id }),
          ),
        );
        // 0.25 USD allows exactly five 0.05 USD reservations.
        expect(decisions.filter((d) => d.status === "RESERVED")).toHaveLength(5);
        expect(decisions.filter((d) => d.status === "BUDGET_EXCEEDED")).toHaveLength(35);
        const totals = await instances[0]!.totals({ date: new Date().toISOString().slice(0, 10) });
        expect(totals[0]?.counted).toBe("0.250000");
      } finally {
        await second.$disconnect();
      }
    });

    it("never exceeds a cap when parallel retries reuse one call key", async () => {
      const ledger = ledgerFor({ BUDGET_OPENAI_DAY_USD: "0.10" });
      const callKey = key();
      const decisions = await Promise.all(
        Array.from({ length: 12 }, () => ledger.reserve({ provider: "openai", operation: "search-plan", callKey })),
      );
      expect(decisions.every((d) => d.status === "RESERVED")).toBe(true);
      expect(decisions.filter((d) => d.status === "RESERVED" && !d.reused)).toHaveLength(1);
      expect(await database.providerUsage.count()).toBe(1);
    });
  });

  describe("idempotency, settlement, release and crash expiry", () => {
    it("returns the live reservation for a repeated key, ALREADY_SETTLED after settlement, and a new attempt after release", async () => {
      const ledger = ledgerFor();
      const callKey = key();
      const first = reserved(await ledger.reserve({ provider: "openai", operation: "search-plan", callKey }));
      const again = await ledger.reserve({ provider: "openai", operation: "search-plan", callKey });
      expect(again).toMatchObject({ status: "RESERVED", reused: true });

      await ledger.release(first.id);
      const afterRelease = reserved(await ledger.reserve({ provider: "openai", operation: "search-plan", callKey }));
      expect(afterRelease.attempt).toBe(2);
      expect(afterRelease.id).not.toBe(first.id);

      await ledger.settle(afterRelease.id, { inputTokens: 1, outputTokens: 1 });
      const settled = await ledger.reserve({ provider: "openai", operation: "search-plan", callKey });
      expect(settled).toMatchObject({ status: "ALREADY_SETTLED" });
      expect(await database.providerUsage.count()).toBe(2);
    });

    it("settles to the real cost, freeing the difference, and settling twice changes nothing", async () => {
      const ledger = ledgerFor();
      const owner = await campaign();
      const reservation = reserved(
        await ledger.reserve({ provider: "openai", operation: "search-plan", callKey: key(), campaignId: owner.id }),
      );
      expect((await ledger.totals({ campaignId: owner.id }))[0]?.counted).toBe("0.050000");
      // 1000 input tokens at 2.5 USD per million plus 500 output tokens at 10 USD per million.
      const settled = await ledger.settle(reservation.id, { inputTokens: 1000, outputTokens: 500 });
      expect(settled).toMatchObject({ actualAmount: "0.007500", costKnown: true, overrun: false });
      expect((await ledger.totals({ campaignId: owner.id }))[0]).toMatchObject({
        counted: "0.007500",
        knownAmount: "0.007500",
        unknownCostCalls: 0,
        inputTokens: 1000,
        outputTokens: 500,
      });
      const repeat = await ledger.settle(reservation.id, { inputTokens: 999_999, outputTokens: 999_999 });
      expect(repeat.actualAmount).toBe("0.007500");
    });

    it("charges the web-search fee once per billed search, and treats a missing search count as an unknown cost", async () => {
      const ledger = ledgerFor();
      // Reserved 0.05 + 0.01 fee = 0.06; one billed search costs 0.0075 + 0.01.
      const one = reserved(await ledger.reserve({ provider: "openai", operation: "web-search", callKey: key() }));
      expect(one.reservedAmount).toBe("0.060000");
      expect(await ledger.settle(one.id, { inputTokens: 1000, outputTokens: 500, webSearchCalls: 1 })).toMatchObject({
        actualAmount: "0.017500",
        costKnown: true,
      });
      // Three billed searches are three fees, and the people-search operation is priced the same way.
      const three = reserved(await ledger.reserve({ provider: "openai", operation: "people-web-search", callKey: key() }));
      expect(await ledger.settle(three.id, { inputTokens: 1000, outputTokens: 500, webSearchCalls: 3 })).toMatchObject({
        actualAmount: "0.037500",
        costKnown: true,
      });
      // A web-search operation that does not report its search count cannot be priced.
      const silent = reserved(await ledger.reserve({ provider: "openai", operation: "web-search", callKey: key() }));
      expect(await ledger.settle(silent.id, { inputTokens: 1000, outputTokens: 500 })).toMatchObject({
        actualAmount: "0.060000",
        costKnown: false,
      });
      // A planning call with no search is priced from tokens alone.
      const plan = reserved(await ledger.reserve({ provider: "openai", operation: "search-plan", callKey: key() }));
      expect(await ledger.settle(plan.id, { inputTokens: 1000, outputTokens: 500, webSearchCalls: 0 })).toMatchObject({
        actualAmount: "0.007500",
        costKnown: true,
      });
    });

    it("flags an overrun of the estimate", async () => {
      const ledger = ledgerFor();
      // 100k output tokens at 10 USD per million = 1 USD, far above the 0.05 estimate.
      const plan = reserved(await ledger.reserve({ provider: "openai", operation: "search-plan", callKey: key() }));
      expect(await ledger.settle(plan.id, { inputTokens: 0, outputTokens: 100_000 })).toMatchObject({
        actualAmount: "1.000000",
        overrun: true,
      });
      const row = await database.providerUsage.findUniqueOrThrow({ where: { id: plan.id } });
      expect(row.needsReview).toBe(true);
    });

    it("counts a call toward the run cap even when the caller does not name the run", async () => {
      const owner = await campaign();
      const start = await database.outboxEvent.create({
        data: {
          eventType: "CAMPAIGN_STARTED",
          aggregateType: "campaign",
          aggregateId: owner.id,
          idempotencyKey: `campaign-start:${owner.id}`,
          payload: { campaignId: owner.id },
        },
      });
      const ledger = ledgerFor({ BUDGET_OPENAI_RUN_USD: "0.06" });
      const first = await ledger.reserve({ provider: "openai", operation: "search-plan", callKey: key(), campaignId: owner.id });
      expect(first).toMatchObject({ status: "RESERVED" });
      expect((await database.providerUsage.findFirstOrThrow({ where: { campaignId: owner.id } })).runId).toBe(start.id);
      expect(await ledger.reserve({ provider: "openai", operation: "search-plan", callKey: key(), campaignId: owner.id })).toMatchObject({
        status: "BUDGET_EXCEEDED",
        scope: "RUN",
      });
    });

    it("never reports an unknown cost as zero", async () => {
      const ledger = ledgerFor();
      const owner = await campaign();
      const noUsage = reserved(await ledger.reserve({ provider: "openai", operation: "search-plan", callKey: key(), campaignId: owner.id }));
      expect(await ledger.settle(noUsage.id, {})).toMatchObject({ actualAmount: "0.050000", costKnown: false });

      const noPrice = new ProviderUsageLedger(
        databaseService,
        readProviderBudgetConfig(
          (() => {
            const env = environment();
            delete env.OPENAI_PRICE_INPUT_PER_MILLION_USD;
            return env;
          })(),
        ),
      );
      const unpriced = reserved(await noPrice.reserve({ provider: "openai", operation: "search-plan", callKey: key(), campaignId: owner.id }));
      expect(await noPrice.settle(unpriced.id, { inputTokens: 10, outputTokens: 10 })).toMatchObject({ costKnown: false });

      const totals = (await ledger.totals({ campaignId: owner.id }))[0];
      expect(totals).toMatchObject({ unknownCostCalls: 2, unknownCostAmount: "0.100000", knownAmount: "0.000000" });
      expect(Number(totals?.counted)).toBeGreaterThan(0);
    });

    it("keeps an unsettled reservation counted after the process dies, flags it, and never releases it silently", async () => {
      const ledger = ledgerFor({ BUDGET_OPENAI_DAY_USD: "0.05" });
      const callKey = key();
      const lost = reserved(await ledger.reserve({ provider: "openai", operation: "search-plan", callKey }));
      await database.$executeRawUnsafe(
        `UPDATE provider_usage SET reserved_until = now() - interval '1 minute' WHERE id = '${lost.id}'::uuid`,
      );

      // The cap is still consumed by the lost call, so a new call is refused.
      expect(await ledger.reserve({ provider: "openai", operation: "search-plan", callKey: key() })).toMatchObject({
        status: "BUDGET_EXCEEDED",
        scope: "DAY",
        used: "0.050000",
      });
      const row = await database.providerUsage.findUniqueOrThrow({ where: { id: lost.id } });
      expect(row).toMatchObject({ status: "EXPIRED", needsReview: true, outcomeCode: "RESERVATION_EXPIRED" });
      expect(await ledger.release(lost.id)).toEqual({ status: "EXPIRED" });
      expect((await database.providerUsage.findUniqueOrThrow({ where: { id: lost.id } })).status).toBe("EXPIRED");

      // A retry with the same key makes a separate attempt; the lost spend stays counted.
      const retryLedger = ledgerFor({ BUDGET_OPENAI_DAY_USD: "0.20" });
      const retry = reserved(await retryLedger.reserve({ provider: "openai", operation: "search-plan", callKey }));
      expect(retry.attempt).toBe(2);
      expect((await retryLedger.totals())[0]?.counted).toBe("0.100000");
      expect(await ledger.expireStale()).toBe(0);
    });

    it("refuses to release a settled reservation and to settle a released one", async () => {
      const ledger = ledgerFor();
      const spent = reserved(await ledger.reserve({ provider: "openai", operation: "search-plan", callKey: key() }));
      await ledger.settle(spent.id, { inputTokens: 1, outputTokens: 1 });
      await expect(ledger.release(spent.id)).rejects.toMatchObject({ code: "ALREADY_SETTLED" });

      const freed = reserved(await ledger.reserve({ provider: "openai", operation: "search-plan", callKey: key() }));
      await ledger.release(freed.id);
      await expect(ledger.settle(freed.id, {})).rejects.toBeInstanceOf(ProviderLedgerError);
      expect((await ledger.totals())[0]?.counted).toBe("0.000013");
    });
  });

  describe("units and providers", () => {
    it("counts Apollo in credits and against the global USD cap through the configured rate", async () => {
      const ledger = ledgerFor({ BUDGET_GLOBAL_DAY_USD: "0.30", APOLLO_ESTIMATE_CALL_CREDITS: "2", APOLLO_USD_PER_CREDIT: "0.10" });
      const first = reserved(await ledger.reserve({ provider: "apollo", operation: "people-search", callKey: key() }));
      expect(first).toMatchObject({ unit: "CREDITS", reservedAmount: "2.000000" });
      expect(await ledger.settle(first.id, { credits: "1.5" })).toMatchObject({ actualAmount: "1.500000", costKnown: true });
      const row = await database.providerUsage.findUniqueOrThrow({ where: { id: first.id } });
      expect(row.actualUsd?.toString()).toBe("0.15");

      // 0.15 settled + 0.20 estimate = 0.35 > 0.30 global cap.
      expect(await ledger.reserve({ provider: "apollo", operation: "people-search", callKey: key() })).toMatchObject({
        status: "BUDGET_EXCEEDED",
        scope: "GLOBAL_DAY",
        unit: "USD",
      });
      // An OpenAI call counts toward the same global cap.
      expect(await ledger.reserve({ provider: "openai", operation: "search-plan", callKey: key() })).toMatchObject({
        status: "RESERVED",
      });
    });

    it("counts crawl in requests with optional caps and a missing Apollo credit price fails Apollo closed", async () => {
      const ledger = ledgerFor({ BUDGET_CRAWL_DAY_REQUESTS: "3" });
      const fetches = [];
      for (let index = 0; index < 3; index += 1) {
        fetches.push(reserved(await ledger.reserve({ provider: "crawl", operation: "page-fetch", callKey: key() })));
      }
      expect(fetches[0]).toMatchObject({ unit: "REQUESTS", reservedAmount: "1.000000" });
      expect(await ledger.settle(fetches[0]!.id, { requests: 1 })).toMatchObject({ actualAmount: "1.000000", costKnown: true });
      expect(await ledger.reserve({ provider: "crawl", operation: "page-fetch", callKey: key() })).toMatchObject({
        status: "BUDGET_EXCEEDED",
        unit: "REQUESTS",
      });

      const env = environment();
      delete env.APOLLO_USD_PER_CREDIT;
      const noRate = new ProviderUsageLedger(databaseService, readProviderBudgetConfig(env));
      expect(await noRate.reserve({ provider: "apollo", operation: "people-search", callKey: key() })).toMatchObject({
        status: "CAP_NOT_CONFIGURED",
        variables: ["APOLLO_USD_PER_CREDIT"],
      });
      await expect(ledger.reserve({ provider: "mystery", operation: "x", callKey: key() })).rejects.toBeInstanceOf(ProviderLedgerError);
    });
  });

  describe("shared rate and concurrency limits", () => {
    it("limits requests per minute with a retry-after value, shared by every instance", async () => {
      const second = createPrismaClient(privateUrl.toString());
      try {
        const a = ledgerFor({ PROVIDER_RATE_OPENAI_PER_MINUTE: "4" });
        const b = ledgerFor({ PROVIDER_RATE_OPENAI_PER_MINUTE: "4" }, { client: second } as unknown as DatabaseService);
        const decisions = await Promise.all(
          Array.from({ length: 16 }, (_, index) =>
            (index % 2 === 0 ? a : b).reserve({ provider: "openai", operation: "search-plan", callKey: key() }),
          ),
        );
        expect(decisions.filter((d) => d.status === "RESERVED")).toHaveLength(4);
        const limited = decisions.filter((d) => d.status === "RATE_LIMITED");
        expect(limited).toHaveLength(12);
        const first = limited[0];
        expect(first).toMatchObject({ limit: "REQUESTS_PER_MINUTE" });
        const wait = first?.status === "RATE_LIMITED" ? first.retryAfterSeconds : 0;
        expect(wait).toBeGreaterThanOrEqual(1);
        expect(wait).toBeLessThanOrEqual(60);
      } finally {
        await second.$disconnect();
      }
    });

    it("stops holding an in-flight slot after the in-flight window, while the reservation still counts toward spend", async () => {
      const ledger = ledgerFor({ PROVIDER_CONCURRENCY_OPENAI: "1", PROVIDER_INFLIGHT_SECONDS: "30" });
      const stuck = reserved(await ledger.reserve({ provider: "openai", operation: "search-plan", callKey: key() }));
      expect(await ledger.reserve({ provider: "openai", operation: "search-plan", callKey: key() })).toMatchObject({
        status: "RATE_LIMITED",
        limit: "CONCURRENCY",
      });
      await database.$executeRawUnsafe(`UPDATE provider_usage SET reserved_at = now() - interval '2 minutes' WHERE id = '${stuck.id}'::uuid`);
      expect(await ledger.reserve({ provider: "openai", operation: "search-plan", callKey: key() })).toMatchObject({ status: "RESERVED" });
      expect((await ledger.totals())[0]?.counted).toBe("0.100000");
    });

    it("limits concurrent in-flight calls and frees a slot when a call settles", async () => {
      const ledger = ledgerFor({ PROVIDER_CONCURRENCY_OPENAI: "2" });
      const one = reserved(await ledger.reserve({ provider: "openai", operation: "search-plan", callKey: key() }));
      reserved(await ledger.reserve({ provider: "openai", operation: "search-plan", callKey: key() }));
      expect(await ledger.reserve({ provider: "openai", operation: "search-plan", callKey: key() })).toMatchObject({
        status: "RATE_LIMITED",
        limit: "CONCURRENCY",
      });
      await ledger.settle(one.id, { inputTokens: 1, outputTokens: 1 });
      expect(await ledger.reserve({ provider: "openai", operation: "search-plan", callKey: key() })).toMatchObject({
        status: "RESERVED",
      });
    });
  });

  describe("production caller: ProviderCallAuditor", () => {
    const auditorFor = (overrides: Record<string, string> = {}) => {
      const ledger = ledgerFor(overrides);
      return { ledger, auditor: new ProviderCallAuditor(new AuditService(databaseService), ledger, new CampaignProviderCallGuard(databaseService)) };
    };

    it("reserves before the call, settles the reported usage, and audits without leaking the response", async () => {
      const { auditor } = auditorFor();
      const owner = await campaign();
      const work = vi.fn().mockResolvedValue({ data: "never stored", model: "m", providerResponseId: "r1", usage: { inputTokens: 1000, outputTokens: 500 } });
      await auditor.run({ provider: "openai", operation: "search-plan", campaignId: owner.id, runId: "run-1" }, work);
      const row = await database.providerUsage.findFirstOrThrow({ where: { campaignId: owner.id } });
      expect(row).toMatchObject({ status: "SETTLED", costKnown: true, inputTokens: 1000, outputTokens: 500, runId: "run-1" });
      expect(row.actualAmount?.toString()).toBe("0.0075");
      expect(JSON.stringify(await database.auditLog.findMany())).not.toContain("never stored");
    });

    it("prices a web search from the reported search count", async () => {
      const { auditor } = auditorFor();
      const owner = await campaign();
      await auditor.run({ provider: "openai", operation: "web-search", campaignId: owner.id }, () =>
        Promise.resolve({ usage: { inputTokens: 1000, outputTokens: 500, webSearchCalls: 2 } }),
      );
      const row = await database.providerUsage.findFirstOrThrow({ where: { campaignId: owner.id } });
      expect(row).toMatchObject({ status: "SETTLED", costKnown: true });
      expect(row.actualAmount?.toString()).toBe("0.0275");
    });

    it("refuses over the cap without calling the provider, audits the refusal and throws a typed error", async () => {
      const { auditor } = auditorFor({ BUDGET_OPENAI_DAY_USD: "0.01" });
      const owner = await campaign();
      const work = vi.fn().mockResolvedValue({});
      await expect(auditor.run({ provider: "openai", operation: "web-search", campaignId: owner.id }, work)).rejects.toBeInstanceOf(
        ProviderBudgetError,
      );
      expect(work).not.toHaveBeenCalled();
      expect(await database.providerUsage.count()).toBe(0);
      const audit = await database.auditLog.findFirstOrThrow({ where: { action: "provider.budget_refused" } });
      expect(audit.metadata).toMatchObject({ decision: "BUDGET_EXCEEDED", scope: "DAY", cap: "0.010000" });
    });

    it("fails closed when a cap is missing: no provider call, no ledger row", async () => {
      const env = environment();
      delete env.BUDGET_OPENAI_RUN_USD;
      const ledger = new ProviderUsageLedger(databaseService, readProviderBudgetConfig(env));
      const auditor = new ProviderCallAuditor(new AuditService(databaseService), ledger, new CampaignProviderCallGuard(databaseService));
      const work = vi.fn().mockResolvedValue({});
      await expect(auditor.run({ provider: "openai", operation: "search-plan" }, work)).rejects.toMatchObject({ code: "CAP_NOT_CONFIGURED" });
      expect(work).not.toHaveBeenCalled();
    });

    it("releases the reservation for a client error and holds an unknown cost for any other failure", async () => {
      const { auditor, ledger } = auditorFor();
      const rejected = Object.assign(new Error("429"), { status: 429 });
      await expect(auditor.run({ provider: "openai", operation: "search-plan" }, () => Promise.reject(rejected))).rejects.toBe(rejected);
      expect((await ledger.totals())[0]?.counted ?? "0.000000").toBe("0.000000");

      const timeout = new Error("socket hang up");
      await expect(auditor.run({ provider: "openai", operation: "search-plan" }, () => Promise.reject(timeout))).rejects.toBe(timeout);
      const totals = (await ledger.totals())[0];
      expect(totals).toMatchObject({ counted: "0.050000", unknownCostCalls: 1 });
      const rows = await database.providerUsage.findMany({ orderBy: { createdAt: "asc" } });
      expect(rows.map((row) => row.status)).toEqual(["RELEASED", "SETTLED"]);
    });

    it("never lets a provider error that echoes a secret reach a response, a log line, an audit row or a ledger row, for each OpenAI call site", async () => {
      const secret = "sk-proj-Ph103bSecretKeyAbCdEfGhIjKlMnOpQrStUv";
      const bearer = "Ph103bBearerTokenAbCdEfGhIjKlMn";
      const echo = () =>
        Object.assign(new Error(`Incorrect API key provided: ${secret}. Authorization: Bearer ${bearer}`), { status: 401 });
      const previous = { key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_RESEARCH_MODEL };
      process.env.OPENAI_API_KEY = secret;
      process.env.OPENAI_RESEARCH_MODEL = "test-research-model";
      try {
        const { auditor } = auditorFor();
        const owner = await campaign();
        const parse = vi.fn().mockImplementation(() => Promise.reject(echo()));
        const client = { responses: { parse } } as never;
        const search = new OpenAISearchAdapter(client);
        const claims = new OpenAIClaimExtractionAdapter(client);
        const sites: Array<[string, (call: ProviderCallContext) => Promise<unknown>]> = [
          ["search-plan", (call) => search.plan({} as never, call)],
          ["web-search", (call) => search.search({ context: {} as never, plan: { strategies: [] } as never, maximumResults: 1 }, call)],
          ["claim-extraction", (call) => claims.extract({ organizationId: owner.id, organizationName: "x", documents: [] } as never, call)],
        ];
        const logged: unknown[] = [];
        const filter = new HttpExceptionFilter({ error: (...a: unknown[]) => logged.push(a), warn: (...a: unknown[]) => logged.push(a) } as never);
        const responses: unknown[] = [];
        for (const [operation, work] of sites) {
          const failure = await auditor.run({ provider: "openai", operation, campaignId: owner.id }, work).catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(Error);
          const response = { headers: {} as Record<string, string>, status: 0, body: undefined as unknown };
          const reply = {
            setHeader: (name: string, value: string) => { response.headers[name] = value; },
            status: (code: number) => { response.status = code; return reply; },
            json: (body: object) => { response.body = body; },
          };
          filter.catch(failure, { switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({ id: "req-1", method: "POST", url: "/internal/x" }) }) } as never);
          responses.push(response);
        }
        const everything = JSON.stringify([
          responses,
          logged,
          await database.auditLog.findMany(),
          await database.providerUsage.findMany(),
        ]);
        for (const value of [secret, bearer]) expect(everything).not.toContain(value);
        // The provider rejected each call (401), so nothing was charged and every reservation was released.
        const rows = await database.providerUsage.findMany({ where: { campaignId: owner.id } });
        expect(rows.map((row) => row.status)).toEqual(["RELEASED", "RELEASED", "RELEASED"]);
        expect(rows.every((row) => row.outcomeCode === "PROVIDER_REJECTED")).toBe(true);
      } finally {
        if (previous.key === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = previous.key;
        if (previous.model === undefined) delete process.env.OPENAI_RESEARCH_MODEL;
        else process.env.OPENAI_RESEARCH_MODEL = previous.model;
      }
    });

    it("does not fail a successful call when settlement fails, and the reservation stays counted", async () => {
      const { auditor, ledger } = auditorFor();
      vi.spyOn(ledger, "settle").mockRejectedValueOnce(new Error("database unavailable"));
      const result = await auditor.run({ provider: "openai", operation: "search-plan" }, () => Promise.resolve({ ok: true }));
      expect(result).toEqual({ ok: true });
      expect((await database.providerUsage.findFirstOrThrow()).status).toBe("RESERVED");
      expect((await ledger.totals())[0]?.counted).toBe("0.050000");
    });
  });

  describe("exhaustion outcomes through the discovery stage", () => {
    async function discoveryWith(overrides: Record<string, string>, planner: { plan: ReturnType<typeof vi.fn> }, provider: { search: ReturnType<typeof vi.fn> }) {
      const audit = new AuditService(databaseService);
      const stageRuns = new StageRunService(databaseService, new PrismaCampaignStateReader(databaseService), audit);
      const ledger = ledgerFor(overrides);
      const search = new SearchService(
        databaseService,
        planner as never,
        provider as never,
        {} as unknown as OrganizationResolutionService,
        new ProviderCallAuditor(audit, ledger, new CampaignProviderCallGuard(databaseService)),
      );
      const owner = await campaign();
      await database.outboxEvent.create({
        data: {
          eventType: "CAMPAIGN_STARTED",
          aggregateType: "campaign",
          aggregateId: owner.id,
          idempotencyKey: `campaign-start:${owner.id}`,
          payload: { campaignId: owner.id },
        },
      });
      return { discovery: new DiscoveryStageService(databaseService, search, stageRuns), owner, stageRuns };
    }
    const stubs = () => ({ planner: { plan: vi.fn() }, provider: { search: vi.fn() } });

    it("ends the stage as REVIEW_REQUIRED BUDGET_EXHAUSTED, keeps the campaign, calls no provider, and replays quietly", async () => {
      const { planner, provider } = stubs();
      const { discovery, owner } = await discoveryWith({ BUDGET_OPENAI_DAY_USD: "0.01" }, planner, provider);

      const result = await discovery.run(owner.id);
      expect(result).toMatchObject({ status: "STOPPED", outcome: "BUDGET_EXHAUSTED", campaignId: owner.id });
      expect(planner.plan).not.toHaveBeenCalled();
      expect(provider.search).not.toHaveBeenCalled();
      expect(await database.providerUsage.count()).toBe(0);
      const run = await database.stageRun.findFirstOrThrow({ where: { campaignId: owner.id } });
      expect(run).toMatchObject({ status: "REVIEW_REQUIRED", outcome: "BUDGET_EXHAUSTED" });
      expect(run.outcomeReason).toContain("DAY budget");
      expect((await database.campaign.findUniqueOrThrow({ where: { id: owner.id } })).status).toBe("RUNNING");
      const refusal = await database.auditLog.findFirstOrThrow({ where: { action: "provider.budget_refused", campaignId: owner.id } });
      expect(refusal.metadata).toMatchObject({ decision: "BUDGET_EXCEEDED", scope: "DAY" });

      // A re-delivered start event gets the same explained answer instead of a failure.
      expect(await discovery.run(owner.id)).toMatchObject({ status: "STOPPED", outcome: "BUDGET_EXHAUSTED" });
    });

    it("releases the run for a retry when the provider is rate limited or times out, and the HTTP error carries Retry-After", async () => {
      for (const [failure, code] of [
        [Object.assign(new Error("rate"), { status: 429, headers: new Headers({ "retry-after": "17" }) }), "RATE_LIMITED"],
        [Object.assign(new Error("slow"), { name: "APIConnectionTimeoutError" }), "TIMEOUT"],
      ] as const) {
        const planner = { plan: vi.fn().mockRejectedValue(failure) };
        const { discovery, owner } = await discoveryWith({}, planner, { search: vi.fn() });
        await expect(discovery.run(owner.id)).rejects.toBe(failure);
        expect(classifyProviderError(failure)).toMatchObject({ code, retryable: true });
        const run = await database.stageRun.findFirstOrThrow({ where: { campaignId: owner.id } });
        expect(run.status).toBe("PENDING");
        expect(run.lastError).toMatch(/^Discovery failed: /);
      }
      expect(classifyProviderError(Object.assign(new Error("rate"), { status: 429, headers: new Headers({ "retry-after": "17" }) }))?.retryAfterSeconds).toBe(17);
    });

    it("ends the stage as FAILED CREDIT_EXHAUSTED when the provider has no credit left, and a later operator retry is allowed", async () => {
      const exhausted = Object.assign(new Error("You exceeded your current quota"), { status: 429, code: "insufficient_quota", type: "insufficient_quota" });
      const { discovery, owner } = await discoveryWith({}, { plan: vi.fn().mockRejectedValue(exhausted) }, { search: vi.fn() });
      expect(await discovery.run(owner.id)).toMatchObject({ status: "STOPPED", outcome: "CREDIT_EXHAUSTED" });
      expect(await database.stageRun.findFirstOrThrow({ where: { campaignId: owner.id } })).toMatchObject({
        status: "FAILED",
        outcome: "CREDIT_EXHAUSTED",
      });
      // The provider refused the call, so nothing was charged.
      expect((await database.providerUsage.findFirstOrThrow()).status).toBe("RELEASED");
    });

    it("refuses a provider call from a stage whose campaign was stopped, before any budget is reserved", async () => {
      const { planner, provider } = stubs();
      const { owner } = await discoveryWith({}, planner, provider);
      await database.campaign.update({ where: { id: owner.id }, data: { status: "STOPPED" } });
      const auditor = new ProviderCallAuditor(new AuditService(databaseService), ledgerFor(), new CampaignProviderCallGuard(databaseService));
      const work = vi.fn();
      await expect(auditor.run({ provider: "openai", operation: "search-plan", campaignId: owner.id }, work)).rejects.toMatchObject({
        code: "CAMPAIGN_NOT_ACTIVE",
      });
      expect(work).not.toHaveBeenCalled();
      expect(await database.providerUsage.count()).toBe(0);
      expect(classifyProviderError(await auditor.run({ provider: "openai", operation: "x", campaignId: owner.id }, work).catch((e) => e))).toMatchObject({
        code: "CAMPAIGN_NOT_ACTIVE",
        httpStatus: 409,
      });
    });
  });

  describe("call keys and HTTP answers for every outcome", () => {
    it("keys a stage call by run, attempt and operation: duplicate delivery inside an attempt is refused, a new attempt is a new reservation", async () => {
      const { auditor } = (() => {
        const ledger = ledgerFor();
        return { auditor: new ProviderCallAuditor(new AuditService(databaseService), ledger, new CampaignProviderCallGuard(databaseService)) };
      })();
      const owner = await campaign();
      const stageRunId = (
        await database.stageRun.create({
          data: { campaignId: owner.id, entityType: "campaign", entityId: owner.id, stage: "DISCOVERY", inputHash: "a".repeat(64) },
        })
      ).id;
      const call = () => auditor.run({ provider: "openai", operation: "search-plan", campaignId: owner.id }, () => Promise.resolve({ usage: { inputTokens: 10, outputTokens: 10 } }));
      const firstAttempt = () => runWithCorrelation("trace-attempt-0001", call, { stageRunId, stageAttempt: 1 });
      const secondAttempt = () => runWithCorrelation("trace-attempt-0002", call, { stageRunId, stageAttempt: 2 });

      await firstAttempt();
      await expect(firstAttempt()).rejects.toMatchObject({ code: "ALREADY_SETTLED" });
      await secondAttempt();
      const keys = (await database.providerUsage.findMany({ orderBy: { reservedAt: "asc" } })).map((row) => row.callKey);
      expect(keys).toEqual([`${stageRunId}:a1:search-plan`, `${stageRunId}:a2:search-plan`]);
    });

    it("answers each outcome with its status, a generic body and Retry-After only where a retry can succeed", () => {
      const filter = new HttpExceptionFilter({ error: vi.fn(), warn: vi.fn() } as never);
      const answer = (error: unknown) => {
        const response = { headers: {} as Record<string, string>, status: 0, body: {} as Record<string, unknown> };
        const reply = {
          setHeader: (name: string, value: string) => { response.headers[name] = value; },
          status: (code: number) => { response.status = code; return reply; },
          json: (body: object) => { response.body = body as Record<string, unknown>; },
        };
        filter.catch(error, { switchToHttp: () => ({ getResponse: () => reply, getRequest: () => ({ id: "r", method: "POST", url: "/internal/x" }) }) } as never);
        return response;
      };
      const budget = answer(new ProviderBudgetError("openai", "search-plan", { status: "BUDGET_EXCEEDED", scope: "DAY", unit: "USD", cap: "5.000000", used: "4.990000", requested: "0.050000" }));
      expect(budget).toMatchObject({ status: 409, body: { error: "BUDGET_EXHAUSTED", retryable: false } });
      expect(budget.headers["Retry-After"]).toBeUndefined();

      const limited = answer(new ProviderBudgetError("openai", "x", { status: "RATE_LIMITED", limit: "REQUESTS_PER_MINUTE", retryAfterSeconds: 12 }));
      expect(limited).toMatchObject({ status: 429, headers: { "Retry-After": "12" }, body: { error: "RATE_LIMITED", retryable: true, retryAfterSeconds: 12 } });

      const timeout = answer(Object.assign(new Error("slow"), { name: "APIConnectionTimeoutError" }));
      expect(timeout).toMatchObject({ status: 504, body: { error: "TIMEOUT", retryable: true } });
      expect(timeout.headers["Retry-After"]).toBeDefined();

      const credit = answer(Object.assign(new Error("quota"), { status: 429, code: "insufficient_quota" }));
      expect(credit).toMatchObject({ status: 402, body: { error: "CREDIT_EXHAUSTED", retryable: false } });
      expect(credit.headers["Retry-After"]).toBeUndefined();

      const stopped = answer(new ProviderBudgetError("openai", "x", { status: "CAMPAIGN_NOT_ACTIVE", campaignState: "TERMINAL" }));
      expect(stopped).toMatchObject({ status: 409, body: { error: "CAMPAIGN_NOT_ACTIVE" } });

      // An ordinary provider failure keeps its existing handling and is not reclassified.
      expect(answer(new Error("boom"))).toMatchObject({ status: 500, body: { error: "INTERNAL_SERVER_ERROR" } });
      expect(classifyProviderError(new Error("boom"))).toBeNull();
    });
  });

  describe("application startup", () => {
    it("refuses to boot when a configured paid provider lacks a cap, and boots with the ledger resolvable when it has them", async () => {
      process.env.OPENAI_API_KEY = "sk-startup-test-key-not-real";
      process.env.N8N_SERVICE_SECRET = "ph103a-startup-secret-with-enough-entropy";
      process.env.N8N_BASE_URL = "http://n8n.test";
      const saveCap = process.env.BUDGET_OPENAI_DAY_USD;
      delete process.env.BUDGET_OPENAI_DAY_USD;
      // abortOnError would end the test worker; production keeps the default and exits on this error.
      await expect(NestFactory.create(ProviderBudgetModule, { abortOnError: false, logger: false })).rejects.toThrow(
        /BUDGET_OPENAI_DAY_USD/,
      );
      process.env.BUDGET_OPENAI_DAY_USD = saveCap ?? "100000";
      const app = await createApp();
      try {
        expect(app.get(ProviderUsageLedger)).toBeInstanceOf(ProviderUsageLedger);
      } finally {
        await app.close();
      }
    }, 60_000);
  });
});
