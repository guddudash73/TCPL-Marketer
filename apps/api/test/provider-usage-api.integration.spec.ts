import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { createPrismaClient } from "@tcpl-marketer/database";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProviderCallAuditor } from "../src/audit/provider-call-auditor.service.js";
import { PasswordHasher } from "../src/auth/password-hasher.js";
import { createApp } from "../src/bootstrap.js";
import { runWithCorrelation } from "../src/common/correlation/correlation-context.js";
import { alertReason } from "../src/provider-budget/provider-usage-report.service.js";
import { ProviderUsageLedger } from "../src/provider-budget/provider-usage-ledger.service.js";

// Private database per file: the dev database and other files' rows are never touched.
const baseUrl = process.env.DATABASE_URL ?? "postgresql://app:app@localhost:5432/tcpl_marketer";
const databaseName = `tcpl_test_usageapi_${randomUUID().replaceAll("-", "")}`;
const privateUrl = new URL(baseUrl);
privateUrl.pathname = `/${databaseName}`;

const password = "PH103d-Test-Password!2026";
const accounts = {
  admin: { email: "ph103d-admin@example.test", role: "ADMIN" },
  manager: { email: "ph103d-manager@example.test", role: "MANAGER" },
  other: { email: "ph103d-other@example.test", role: "VIEWER" },
} as const;

const environmentKeys = [
  "DATABASE_URL", "DIRECT_URL", "N8N_SERVICE_SECRET", "N8N_BASE_URL",
  "BUDGET_OPENAI_RUN_USD", "BUDGET_OPENAI_CAMPAIGN_USD", "BUDGET_OPENAI_DAY_USD", "BUDGET_GLOBAL_DAY_USD",
  "OPENAI_PRICE_INPUT_PER_MILLION_USD", "OPENAI_PRICE_OUTPUT_PER_MILLION_USD", "OPENAI_WEB_SEARCH_FEE_USD", "BUDGET_ALERT_PERCENT",
] as const;
const saved: Record<string, string | undefined> = {};

describe("provider usage API and budget alerts (private PostgreSQL database)", () => {
  const admin = createPrismaClient(baseUrl);
  let database: ReturnType<typeof createPrismaClient>;
  let app: INestApplication;
  let gateway: ProviderCallAuditor;
  let ledger: ProviderUsageLedger;
  let userId = "";
  let sectorId = "";
  const sessions = {} as Record<keyof typeof accounts, ReturnType<typeof request.agent>>;
  let campaignA = "";
  let startA = "";

  async function campaign(status: "RUNNING" | "STOPPED" = "RUNNING") {
    const created = await database.campaign.create({
      data: { name: `PH1-03d ${randomUUID()}`, sectorId, createdByUserId: userId, status, researchDepth: "STANDARD", targetLeadCount: 3, minimumScore: 70, dailyEmailLimit: 10 },
    });
    const start = await database.outboxEvent.create({
      data: { eventType: "CAMPAIGN_STARTED", aggregateType: "campaign", aggregateId: created.id, idempotencyKey: `campaign-start:${created.id}`, payload: { campaignId: created.id } },
    });
    return { id: created.id, start: start.id };
  }

  /** A provider call that reports no usage: it settles at its estimate with an unknown cost. */
  const unknownCall = (campaignId: string) =>
    gateway.run({ provider: "openai", operation: "claim-extraction", campaignId }, () => Promise.resolve({}));

  beforeAll(async () => {
    for (const name of environmentKeys) saved[name] = process.env[name];
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    process.env.DATABASE_URL = privateUrl.toString();
    process.env.DIRECT_URL = privateUrl.toString();
    process.env.N8N_SERVICE_SECRET = "ph103d-service-secret-with-sufficient-entropy";
    process.env.N8N_BASE_URL = "http://n8n.test";
    // Tiny OpenAI run and campaign caps so alerts are easy to reach; the daily caps stay roomy.
    process.env.BUDGET_OPENAI_RUN_USD = "0.10";
    process.env.BUDGET_OPENAI_CAMPAIGN_USD = "0.10";
    process.env.BUDGET_OPENAI_DAY_USD = "100";
    process.env.BUDGET_GLOBAL_DAY_USD = "5";
    process.env.OPENAI_PRICE_INPUT_PER_MILLION_USD = "2.5";
    process.env.OPENAI_PRICE_OUTPUT_PER_MILLION_USD = "10";
    process.env.OPENAI_WEB_SEARCH_FEE_USD = "0.01";
    delete process.env.BUDGET_ALERT_PERCENT;
    execSync("pnpm --filter @tcpl-marketer/database exec prisma migrate deploy", { env: process.env, stdio: "ignore" });
    database = createPrismaClient(privateUrl.toString());
    userId = (await database.user.create({ data: { email: `ph103d-${randomUUID()}@example.test`, passwordHash: "unused" } })).id;
    sectorId = (await database.sector.create({ data: { name: "PH1-03d sector", slug: `ph103d-${randomUUID()}` } })).id;
    const passwordHash = await new PasswordHasher().hash(password);
    for (const account of Object.values(accounts)) {
      const role = await database.role.upsert({ where: { name: account.role }, create: { name: account.role }, update: {} });
      await database.user.create({ data: { email: account.email, passwordHash, roles: { create: { roleId: role.id } } } });
    }
    app = await createApp();
    await app.init();
    gateway = app.get(ProviderCallAuditor);
    ledger = app.get(ProviderUsageLedger);
    for (const [name, account] of Object.entries(accounts)) {
      const agent = request.agent(app.getHttpServer());
      await agent.post("/auth/login").send({ email: account.email, password }).expect(200);
      sessions[name as keyof typeof accounts] = agent;
    }
    const a = await campaign();
    campaignA = a.id;
    startA = a.start;
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await database?.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.$disconnect();
    for (const name of environmentKeys) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  describe("authorization and validation", () => {
    it("rejects an unauthenticated call, forbids a role without ADMIN or MANAGER, and allows both of those roles", async () => {
      for (const path of ["/provider-usage", `/campaigns/${campaignA}/provider-usage`]) {
        await request(app.getHttpServer()).get(path).expect(401);
        await sessions.other.get(path).expect(403);
        await sessions.manager.get(path).expect(200);
        await sessions.admin.get(path).expect(200);
      }
    });

    it("answers 404 for an unknown campaign and 400 for a malformed ID or filter", async () => {
      await sessions.manager.get(`/campaigns/${randomUUID()}/provider-usage`).expect(404);
      await sessions.manager.get(`/provider-usage?campaignId=${randomUUID()}`).expect(404);
      await sessions.manager.get("/campaigns/not-a-uuid/provider-usage").expect(400);
      for (const query of ["page=0", "pageSize=500", "pageSize=0", "day=2026-13-40", "day=yesterday", "provider=mystery", "stage=NOPE", "status=LOST", "unknown=1"]) {
        await sessions.manager.get(`/provider-usage?${query}`).expect(400);
      }
      // The campaign comes from the path, so a campaign filter on the campaign endpoint is refused.
      await sessions.manager.get(`/campaigns/${campaignA}/provider-usage?campaignId=${campaignA}`).expect(400);
    });
  });

  describe("content, pagination, filters and totals", () => {
    let stageRunId = "";

    beforeAll(async () => {
      stageRunId = (
        await database.stageRun.create({
          data: { campaignId: campaignA, entityType: "campaign", entityId: campaignA, stage: "DISCOVERY", inputHash: "b".repeat(64) },
        })
      ).id;
      // A priced plan call inside a stage run (0.0075 USD) and a priced web search with one billed search (0.0175 USD).
      await runWithCorrelation(
        "trace-usage-0001",
        () => gateway.run({ provider: "openai", operation: "search-plan", campaignId: campaignA }, () => Promise.resolve({ usage: { inputTokens: 1000, outputTokens: 500 } })),
        { stageRunId, stageAttempt: 1 },
      );
      await gateway.run({ provider: "openai", operation: "web-search", campaignId: campaignA }, () =>
        Promise.resolve({ usage: { inputTokens: 1000, outputTokens: 500, webSearchCalls: 1 } }),
      );
      await gateway.run({ provider: "apollo", operation: "people-search", campaignId: campaignA }, () => Promise.resolve({ usage: { requests: 1, credits: 0 } }));
      await gateway.run({ provider: "crawl", operation: "page-fetch", campaignId: campaignA }, (call) => {
        call.recordRequest(3);
        return Promise.resolve({});
      });
      await unknownCall(campaignA);
    });

    it("lists calls with their usage and flags and nothing else", async () => {
      const response = await sessions.manager.get(`/campaigns/${campaignA}/provider-usage`).expect(200);
      expect(response.body.scope).toMatchObject({ campaignId: campaignA, runId: startA });
      expect(response.body.calls.total).toBe(5);
      const byOperation = Object.fromEntries(response.body.calls.items.map((item: { operation: string }) => [item.operation, item]));
      expect(byOperation["search-plan"]).toMatchObject({ provider: "openai", status: "SETTLED", unit: "USD", actualAmount: "0.007500", inputTokens: 1000, outputTokens: 500, costKnown: true, stage: "DISCOVERY", stageRunId });
      expect(byOperation["web-search"]).toMatchObject({ webSearchCalls: 1, actualAmount: "0.017500", costKnown: true });
      expect(byOperation["people-search"]).toMatchObject({ provider: "apollo", unit: "CREDITS", actualAmount: "0.000000", costKnown: true });
      expect(byOperation["page-fetch"]).toMatchObject({ provider: "crawl", unit: "REQUESTS", requests: 3, actualAmount: "3.000000" });
      expect(byOperation["claim-extraction"]).toMatchObject({ costKnown: false, needsReview: true, actualAmount: "0.050000", outcomeCode: "COST_UNKNOWN" });
      // Only these fields are exposed: no request body, response body, key or call key.
      expect(Object.keys(byOperation["search-plan"]).sort()).toEqual(
        ["actualAmount", "attempt", "campaignId", "costKnown", "credits", "id", "inputTokens", "needsReview", "operation", "outcomeCode", "outputTokens", "provider", "requests", "reservedAmount", "reservedAt", "runId", "settledAt", "stage", "stageRunId", "status", "unit", "usageDate", "webSearchCalls"].sort(),
      );
    });

    it("reports totals against each cap per unit, with the unknown cost on its own and never as zero", async () => {
      const { body } = await sessions.manager.get(`/campaigns/${campaignA}/provider-usage`).expect(200);
      const openai = body.providers.find((row: { provider: string }) => row.provider === "openai");
      // 0.0075 + 0.0175 + 0.05 (the unknown call held at its estimate) against the 0.10 run and campaign caps.
      expect(openai.windows.campaign).toEqual({ used: "0.075000", cap: "0.100000", remaining: "0.025000", percent: 75 });
      expect(openai.windows.run).toEqual({ used: "0.075000", cap: "0.100000", remaining: "0.025000", percent: 75 });
      expect(openai.windows.day.cap).toBe("100.000000");
      expect(openai.unknownCost).toEqual({ calls: 1, amount: "0.050000" });
      const apollo = body.providers.find((row: { provider: string }) => row.provider === "apollo");
      expect(apollo).toMatchObject({ unit: "CREDITS", unknownCost: { calls: 0 } });
      expect(apollo.windows.day.used).toBe("0.000000");
      const crawl = body.providers.find((row: { provider: string }) => row.provider === "crawl");
      expect(crawl).toMatchObject({ unit: "REQUESTS", requests: 3 });
      expect(crawl.windows.day).toEqual({ used: "3.000000", cap: null, remaining: null, percent: null });
      expect(body.global).toEqual({ unit: "USD", day: { used: "0.075000", cap: "5.000000", remaining: "4.925000", percent: 1.5 } });
    });

    it("paginates and filters by provider, stage, day, status and campaign", async () => {
      const first = await sessions.manager.get(`/campaigns/${campaignA}/provider-usage?pageSize=2&page=1`).expect(200);
      const second = await sessions.manager.get(`/campaigns/${campaignA}/provider-usage?pageSize=2&page=2`).expect(200);
      const third = await sessions.manager.get(`/campaigns/${campaignA}/provider-usage?pageSize=2&page=3`).expect(200);
      const ids = [...first.body.calls.items, ...second.body.calls.items, ...third.body.calls.items].map((item: { id: string }) => item.id);
      expect(first.body.calls).toMatchObject({ page: 1, pageSize: 2, total: 5 });
      expect([first, second, third].map((r) => r.body.calls.items.length)).toEqual([2, 2, 1]);
      expect(new Set(ids).size).toBe(5);

      const openaiOnly = await sessions.manager.get(`/campaigns/${campaignA}/provider-usage?provider=openai`).expect(200);
      expect(openaiOnly.body.calls.total).toBe(3);
      const staged = await sessions.manager.get(`/campaigns/${campaignA}/provider-usage?stage=DISCOVERY`).expect(200);
      expect(staged.body.calls.items.map((item: { operation: string }) => item.operation)).toEqual(["search-plan"]);
      const unsettled = await sessions.manager.get(`/campaigns/${campaignA}/provider-usage?status=RESERVED`).expect(200);
      expect(unsettled.body.calls.total).toBe(0);

      const crawlRow = (await database.providerUsage.findFirstOrThrow({ where: { campaignId: campaignA, provider: "crawl" } })).id;
      await database.$executeRawUnsafe(`UPDATE provider_usage SET usage_date = usage_date - 1 WHERE id = '${crawlRow}'::uuid`);
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      const today = new Date().toISOString().slice(0, 10);
      const past = await sessions.manager.get(`/campaigns/${campaignA}/provider-usage?day=${yesterday}`).expect(200);
      expect(past.body.calls.items.map((item: { operation: string }) => item.operation)).toEqual(["page-fetch"]);
      expect(past.body.providers.find((row: { provider: string }) => row.provider === "crawl").windows.day.used).toBe("3.000000");
      const now = await sessions.manager.get(`/campaigns/${campaignA}/provider-usage?day=${today}`).expect(200);
      expect(now.body.calls.total).toBe(4);

      const system = await sessions.admin.get(`/provider-usage?campaignId=${campaignA}&provider=apollo`).expect(200);
      expect(system.body.calls.items).toHaveLength(1);
      expect((await sessions.admin.get("/provider-usage").expect(200)).body.calls.total).toBeGreaterThanOrEqual(5);
    });

    it("never exposes a credential or an environment secret", async () => {
      const text = JSON.stringify([
        (await sessions.manager.get(`/campaigns/${campaignA}/provider-usage`).expect(200)).body,
        (await sessions.admin.get("/provider-usage").expect(200)).body,
      ]);
      for (const secret of [process.env.N8N_SERVICE_SECRET as string, password]) expect(text).not.toContain(secret);
      expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{16,}|Bearer |call_key|callKey|BUDGET_|_API_KEY/);
    });
  });

  describe("alert reasons", () => {
    it("says a call was refused when its size alone would pass a cap that nothing has used up yet", () => {
      const base = { kind: "CAP_REACHED", scope: "RUN" as const, provider: "apollo", thresholdPercent: 100, unit: "CREDITS" as const };
      expect(alertReason({ ...base, cap: "1.000000", used: "0.000000" })).toMatch(/call was refused because the amount it needs would pass the run cap \(0\.000000 of 1\.000000 CREDITS used so far\)/);
      expect(alertReason({ ...base, cap: "1.000000", used: "1.000000" })).toMatch(/budget for apollo reached its cap \(1\.000000 of 1\.000000 CREDITS\)/);
      expect(alertReason({ ...base, cap: "1.000000", used: "0.000000" })).not.toMatch(/BUDGET_|API_KEY/);
    });
  });

  describe("alerts", () => {
    const alertsFor = (campaignId: string) =>
      database.providerBudgetAlert.findMany({ where: { campaignId }, orderBy: [{ createdAt: "asc" }, { alertKey: "asc" }] });
    const auditFor = (campaignId: string) => database.auditLog.count({ where: { action: "provider.budget_alert", campaignId } });

    it("raises the threshold alert and the cap alert once each per scope, audits each once, and does not repeat them on later calls", async () => {
      const b = await campaign();
      await unknownCall(b.id); // 0.05 of 0.10: 50 percent, below the 80 percent threshold
      expect(await alertsFor(b.id)).toHaveLength(0);
      await unknownCall(b.id); // 0.10 of 0.10: the threshold and the cap, for the run and for the campaign
      const raised = await alertsFor(b.id);
      expect(raised.map((alert) => `${alert.scope}:${alert.kind}:${alert.thresholdPercent}`).sort()).toEqual([
        "CAMPAIGN:CAP_REACHED:100",
        "CAMPAIGN:THRESHOLD:80",
        "RUN:CAP_REACHED:100",
        "RUN:THRESHOLD:80",
      ]);
      expect(await auditFor(b.id)).toBe(4);

      // A call over the cap is refused; the cap is already alerted for these windows, so nothing new is raised.
      await expect(unknownCall(b.id)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
      await expect(unknownCall(b.id)).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
      expect(await alertsFor(b.id)).toHaveLength(4);
      expect(await auditFor(b.id)).toBe(4);
    });

    it("shows each alert in the campaign report as an actionable reason that names the scope and no setting or secret", async () => {
      const b = await campaign();
      await unknownCall(b.id);
      await unknownCall(b.id);
      const { body } = await sessions.manager.get(`/campaigns/${b.id}/provider-usage`).expect(200);
      expect(body.alerts).toHaveLength(4);
      const reasons = body.alerts.map((alert: { reason: string }) => alert.reason).join("\n");
      expect(reasons).toMatch(/run budget for openai reached its cap \(0\.100000 of 0\.100000 USD\)/);
      expect(reasons).toMatch(/campaign budget for openai is 80% used/);
      expect(reasons).toMatch(/owner/);
      expect(reasons).not.toMatch(/BUDGET_|API_KEY|sk-/);
      const system = await sessions.admin.get("/provider-usage").expect(200);
      expect(system.body.alerts.length).toBeGreaterThanOrEqual(4);
    });

    it("raises each alert exactly once when many calls cross the same threshold at the same moment", async () => {
      const c = await campaign();
      const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => unknownCall(c.id)));
      expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(2);
      const raised = await alertsFor(c.id);
      expect(raised).toHaveLength(4);
      expect(new Set(raised.map((alert) => alert.alertKey)).size).toBe(4);
      expect(await auditFor(c.id)).toBe(4);
    });

    it("raises a new alert for a new window: another campaign, and another UTC day", async () => {
      const first = await campaign();
      const second = await campaign();
      await unknownCall(first.id);
      await unknownCall(first.id);
      await unknownCall(second.id);
      await unknownCall(second.id);
      expect((await alertsFor(first.id)).length).toBe(4);
      expect((await alertsFor(second.id)).length).toBe(4);

      // A daily alert is keyed by its UTC day: the same crossing on another day is a different alert.
      const today = new Date().toISOString().slice(0, 10);
      const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
      await database.providerBudgetAlert.create({ data: { alertKey: `DAY:openai:${yesterday}:100`, kind: "CAP_REACHED", scope: "DAY", provider: "openai", windowKey: yesterday, thresholdPercent: 100 } });
      const keys = (await database.providerBudgetAlert.findMany({ where: { scope: "DAY" } })).map((alert) => alert.alertKey);
      expect(keys).toContain(`DAY:openai:${yesterday}:100`);
      expect(keys).not.toContain(`DAY:openai:${today}:100`);
    });

    it("alerts once when a reservation was never settled, and says so in the report", async () => {
      const d = await campaign();
      const hold = await ledger.reserve({ provider: "openai", operation: "claim-extraction", callKey: `hold-${randomUUID()}`, campaignId: d.id });
      expect(hold.status).toBe("RESERVED");
      const holdId = hold.status === "RESERVED" ? hold.reservation.id : "";
      await database.$executeRawUnsafe(`UPDATE provider_usage SET reserved_until = now() - interval '1 minute' WHERE id = '${holdId}'::uuid`);

      // The expired hold still counts toward the tiny cap, so the second call may be refused; the sweep that finds the
      // hold runs first in either case, and a second sweep finds nothing new.
      const next = () => gateway.run({ provider: "openai", operation: "search-plan", campaignId: d.id }, () => Promise.resolve({ usage: { inputTokens: 1, outputTokens: 1 } })).catch((error: unknown) => error);
      await next();
      await next();
      const expired = (await alertsFor(d.id)).filter((alert) => alert.kind === "EXPIRED_HOLD");
      expect(expired).toHaveLength(1);
      expect(expired[0]?.alertKey).toBe(`EXPIRED:${holdId}`);
      expect(await database.auditLog.count({ where: { action: "provider.budget_alert", campaignId: d.id } })).toBeGreaterThanOrEqual(1);
      const { body } = await sessions.manager.get(`/campaigns/${d.id}/provider-usage`).expect(200);
      expect(body.alerts.find((alert: { kind: string }) => alert.kind === "EXPIRED_HOLD").reason).toMatch(/never settled/);
      expect(body.providers.find((row: { provider: string }) => row.provider === "openai").expiredUnsettled).toBe(1);
    });
  });
});
