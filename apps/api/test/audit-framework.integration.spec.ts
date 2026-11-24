import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { Logger, type INestApplication } from "@nestjs/common";
import { createPrismaClient } from "@tcpl-marketer/database";
import { Logger as PinoLogger } from "nestjs-pino";
import { CAMPAIGN_LIFECYCLE_OWNER, STAGE_DEFINITIONS } from "@tcpl-marketer/orchestration-contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { AUDIT_EVENTS } from "../src/audit/audit-events.js";
import { AuditEntryError } from "../src/audit/audit-row.js";
import { AuditService, AuditWriteError } from "../src/audit/audit.service.js";
import { ProviderCallAuditor } from "../src/audit/provider-call-auditor.service.js";
import { PasswordHasher } from "../src/auth/password-hasher.js";
import { createApp } from "../src/bootstrap.js";
import { runWithCorrelation } from "../src/common/correlation/correlation-context.js";
import type { DatabaseService } from "../src/database/database.service.js";
import { PrismaCampaignStateReader } from "../src/orchestration/prisma-campaign-state-reader.js";
import { StageRunService } from "../src/orchestration/stage-run.service.js";
import { readProviderBudgetConfig } from "../src/provider-budget/provider-budget.config.js";
import { CampaignProviderCallGuard } from "../src/provider-budget/provider-call-guard.js";
import { ProviderUsageLedger } from "../src/provider-budget/provider-usage-ledger.service.js";
import { OpenAISearchAdapter } from "../src/search/openai-search.adapter.js";
import { serviceHeaders } from "./support/service-auth.js";

// Private database per file, so these tests never touch the dev database or other files' rows.
const baseUrl = process.env.DATABASE_URL ?? "postgresql://app:app@localhost:5432/tcpl_marketer";
const databaseName = `tcpl_test_audit_${randomUUID().replaceAll("-", "")}`;
const privateUrl = new URL(baseUrl);
privateUrl.pathname = `/${databaseName}`;

const serviceSecret = "ph102a-test-service-secret-with-sufficient-entropy";
const OPENAI_SECRET = "sk-proj-Ph102aTestKeyAbCdEfGhIjKlMnOpQrStUv";
const managerEmail = "ph102a-manager@example.test";
const password = "PH102a-Test-Password!2026";
const environmentKeys = ["DATABASE_URL", "DIRECT_URL", "N8N_SERVICE_SECRET", "N8N_BASE_URL", "OPENAI_API_KEY", "OUTBOX_DISPATCH_ENABLED"] as const;
const saved: Record<string, string | undefined> = {};

describe("audit, redaction and correlation framework (private PostgreSQL database)", () => {
  const admin = createPrismaClient(baseUrl);
  let database: ReturnType<typeof createPrismaClient>;
  let databaseService: DatabaseService;
  let audit: AuditService;
  let stageRuns: StageRunService;
  let userId = "";
  let sectorId = "";

  async function seedCampaign(status: "DRAFT" | "RUNNING" = "RUNNING") {
    return database.campaign.create({
      data: {
        name: `PH1-02a ${randomUUID()}`,
        sectorId,
        createdByUserId: userId,
        status,
        researchDepth: "STANDARD",
        targetLeadCount: 3,
        minimumScore: 70,
        dailyEmailLimit: 10,
      },
    });
  }

  beforeAll(async () => {
    for (const key of environmentKeys) saved[key] = process.env[key];
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    process.env.DATABASE_URL = privateUrl.toString();
    process.env.DIRECT_URL = privateUrl.toString();
    process.env.N8N_SERVICE_SECRET = serviceSecret;
    process.env.N8N_BASE_URL = "http://n8n.test";
    process.env.OPENAI_API_KEY = OPENAI_SECRET;
    process.env.OUTBOX_DISPATCH_ENABLED = "true";
    // Applies every migration to an empty database, which is itself part of the proof.
    execSync("pnpm --filter @tcpl-marketer/database exec prisma migrate deploy", { env: process.env, stdio: "ignore" });
    database = createPrismaClient(privateUrl.toString());
    databaseService = { client: database } as unknown as DatabaseService;
    audit = new AuditService(databaseService);
    stageRuns = new StageRunService(databaseService, new PrismaCampaignStateReader(databaseService), audit);
    const user = await database.user.create({ data: { email: `ph102a-${randomUUID()}@example.test`, passwordHash: "unused" } });
    userId = user.id;
    sectorId = (await database.sector.create({ data: { name: "PH1-02a sector", slug: `ph102a-${randomUUID()}` } })).id;
  }, 120_000);

  afterAll(async () => {
    await database?.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.$disconnect();
    for (const key of environmentKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.unstubAllGlobals();
  });

  beforeEach(async () => {
    await database.auditLog.deleteMany({});
  });

  describe("shared audit writer", () => {
    it("rejects unknown actions, unknown metadata keys and missing required metadata", async () => {
      await expect(audit.record({ action: "campaign.exploded" } as never)).rejects.toBeInstanceOf(AuditEntryError);
      await expect(
        audit.record({ action: "campaign.created", metadata: { automationMode: "MANUAL_REVIEW", status: "DRAFT", extra: "x" } } as never),
      ).rejects.toBeInstanceOf(AuditEntryError);
      await expect(
        audit.record({ action: "campaign.created", metadata: { automationMode: "MANUAL_REVIEW" } } as never),
      ).rejects.toBeInstanceOf(AuditEntryError);
      await expect(audit.record({ action: "operator.retry_requested", metadata: { stage: "CRAWL" } } as never)).rejects.toBeInstanceOf(AuditEntryError);
      expect(await database.auditLog.count()).toBe(0);
    });

    it("redacts the payload and stamps the correlation ID and campaign from the current trace", async () => {
      const campaign = await seedCampaign();
      await runWithCorrelation(
        "trace-redact-0001",
        () =>
          audit.record({
            action: "orchestration.event_dead_lettered",
            resourceId: randomUUID(),
            metadata: {
              eventType: "CAMPAIGN_STARTED",
              aggregateId: campaign.id,
              attempts: 3,
              reason: `n8n said Authorization: Bearer abcdefghijklmnopqrstuvwx and key ${OPENAI_SECRET} and ${serviceSecret}`,
            },
          }),
        { campaignId: campaign.id },
      );
      const row = await database.auditLog.findFirstOrThrow({ where: { action: "orchestration.event_dead_lettered" } });
      expect(row.correlationId).toBe("trace-redact-0001");
      expect(row.campaignId).toBe(campaign.id);
      const stored = JSON.stringify(row);
      for (const secret of [OPENAI_SECRET, "abcdefghijklmnopqrstuvwx", serviceSecret]) expect(stored).not.toContain(secret);
    });

    it("writes a critical event in the same transaction as the change, and rolls the change back if the audit fails", async () => {
      const slug = `ph102a-${randomUUID()}`;
      const created = await audit.withAudit(
        (transaction) => transaction.sector.create({ data: { name: "Audited sector", slug } }),
        (sector) => ({ action: "configuration.sector.created", resourceId: sector.id, actorUserId: userId }),
      );
      expect(await database.auditLog.count({ where: { action: "configuration.sector.created", resourceId: created.id } })).toBe(1);

      const failingSlug = `ph102a-${randomUUID()}`;
      await expect(
        audit.withAudit(
          (transaction) => transaction.sector.create({ data: { name: "Must not survive", slug: failingSlug } }),
          // A user that does not exist makes the audit insert fail.
          (sector) => ({ action: "configuration.sector.created", resourceId: sector.id, actorUserId: randomUUID() }),
        ),
      ).rejects.toBeInstanceOf(AuditWriteError);
      expect(await database.sector.count({ where: { slug: failingSlug } })).toBe(0);
    });

    it("shares one transaction with the change: the audit row can reference data that is not committed yet", async () => {
      const email = `ph102a-tx-${randomUUID()}@example.test`;
      const user = await audit.withAudit(
        (transaction) => transaction.user.create({ data: { email, passwordHash: "unused" } }),
        // This foreign key only resolves if the audit insert runs inside the same transaction.
        (created) => ({ action: "auth.logout", resourceId: created.id, actorUserId: created.id }),
      );
      expect(await database.auditLog.count({ where: { actorUserId: user.id } })).toBe(1);
    });

    it("keeps an audit row out of the database when the surrounding transaction rolls back", async () => {
      await expect(
        database.$transaction(async (transaction) => {
          await audit.record({ action: "campaign.updated", resourceId: randomUUID() }, transaction);
          throw new Error("force a rollback");
        }),
      ).rejects.toThrow("force a rollback");
      expect(await database.auditLog.count({ where: { action: "campaign.updated" } })).toBe(0);
    });

    it("never hides a failed non-critical write: it is logged with the correlation ID and counted", async () => {
      const errorLog = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
      const before = audit.failedWrites;
      await runWithCorrelation("trace-failure-0001", () =>
        audit.record({ action: "auth.login.failed", resourceId: "someone@example.test", actorUserId: randomUUID() }),
      );
      expect(audit.failedWrites).toBe(before + 1);
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({ msg: "Audit write failed", action: "auth.login.failed", critical: false, correlationId: "trace-failure-0001" }),
      );
      errorLog.mockRestore();
    });

    it("defines every configuration event as critical with its resource type", () => {
      for (const entity of ["sector", "capability", "deliverable", "target_profile", "decision_maker"]) {
        for (const verb of ["created", "updated", "deleted"]) {
          const definition = AUDIT_EVENTS[`configuration.${entity}.${verb}` as keyof typeof AUDIT_EVENTS];
          expect(definition.critical).toBe(true);
        }
      }
    });

    it("emits operator-retry events through a test caller and keeps reserved send, reply and assignment schemas", async () => {
      const run = randomUUID();
      await audit.record({
        action: "operator.retry_requested",
        resourceId: run,
        actorUserId: userId,
        metadata: { stage: "CRAWL", reason: "Provider timeout", originalIdempotencyKey: "campaign-start:abc" },
      });
      await audit.record({ action: "operator.dead_letter_requeued", resourceId: randomUUID(), actorUserId: userId, metadata: { eventType: "CAMPAIGN_STARTED", reason: "Fixed n8n route" } });
      await audit.record({ action: "operator.dead_letter_cleared", resourceId: randomUUID(), actorUserId: userId, metadata: { eventType: "CAMPAIGN_STARTED", reason: "Duplicate" } });
      expect(await database.auditLog.count({ where: { action: { startsWith: "operator." } } })).toBe(3);
      expect(Object.keys(AUDIT_EVENTS)).toEqual(expect.arrayContaining(["email.sent", "reply.received", "lead.assigned"]));
    });
  });

  describe("stage transitions and provider calls", () => {
    it("audit every stage run state change with from, to, attempt and the run's correlation ID", async () => {
      const campaign = await seedCampaign();
      const owner = STAGE_DEFINITIONS.CRAWL.domainOwner;
      const run = await runWithCorrelation("trace-stage-00001", async () => {
        const { run: created } = await stageRuns.ensure({
          campaignId: campaign.id,
          stage: "CRAWL",
          entityType: "lead_candidate",
          entityId: randomUUID(),
          input: { version: randomUUID() },
        });
        await stageRuns.claim(created.id, "worker-a", 60);
        await stageRuns.release(created.id, "worker-a", "Crawl failed: TimeoutError");
        await stageRuns.claim(created.id, "worker-b", 60);
        await stageRuns.finish(created.id, { leaseOwner: "worker-b", actor: owner, status: "SUCCEEDED", outcome: "CRAWLED" });
        return created;
      });
      const rows = await database.auditLog.findMany({ where: { resourceId: run.id, action: "stage.transitioned" }, orderBy: { createdAt: "asc" } });
      const steps = rows.map((row) => {
        const metadata = row.metadata as { from: string | null; to: string; attempt: number };
        return `${metadata.from ?? "none"}>${metadata.to}#${metadata.attempt}`;
      });
      expect(steps).toEqual(["none>PENDING#0", "PENDING>RUNNING#1", "RUNNING>PENDING#1", "PENDING>RUNNING#2", "RUNNING>SUCCEEDED#2"]);
      expect(rows.every((row) => row.correlationId === "trace-stage-00001" && row.campaignId === campaign.id)).toBe(true);
      expect((await stageRuns.get(run.id))?.correlationId).toBe("trace-stage-00001");
    });

    it("audits a campaign-lifecycle transition and a reclaimed lease", async () => {
      const campaign = await seedCampaign();
      const { run } = await stageRuns.ensure({
        campaignId: campaign.id,
        stage: "CRAWL",
        entityType: "lead_candidate",
        entityId: randomUUID(),
        input: { version: randomUUID() },
      });
      await stageRuns.claim(run.id, "worker-x", 60);
      await database.$executeRawUnsafe(`UPDATE stage_runs SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1::uuid`, run.id);
      await stageRuns.reclaimExpired(10);
      await stageRuns.transition(run.id, "CANCELLED", CAMPAIGN_LIFECYCLE_OWNER, "Campaign stopped");
      const reasons = (await database.auditLog.findMany({ where: { resourceId: run.id }, orderBy: { createdAt: "asc" } })).map(
        (row) => (row.metadata as { to: string }).to,
      );
      expect(reasons).toEqual(["PENDING", "RUNNING", "PENDING", "CANCELLED"]);
    });

    it("records a provider call without its request, response or any credential, and rethrows failures unchanged", async () => {
      const auditor = new ProviderCallAuditor(audit, new ProviderUsageLedger(databaseService, readProviderBudgetConfig()), new CampaignProviderCallGuard(databaseService));
      const campaign = await seedCampaign();
      const ok = await auditor.run({ provider: "openai", operation: "search-plan", campaignId: campaign.id }, () =>
        Promise.resolve({ data: "never stored", model: "model-x", providerResponseId: "resp_1", usage: { inputTokens: 10, outputTokens: 5 } }),
      );
      expect(ok.data).toBe("never stored");
      const failure = new Error(`Incorrect API key provided: ${OPENAI_SECRET}`);
      await expect(auditor.run({ provider: "openai", operation: "web-search", campaignId: campaign.id }, () => Promise.reject(failure))).rejects.toBe(failure);
      const rows = await database.auditLog.findMany({ where: { action: "provider.call" }, orderBy: { createdAt: "asc" } });
      expect(rows.map((row) => (row.metadata as { status: string }).status)).toEqual(["SUCCEEDED", "FAILED"]);
      expect(rows[0]?.metadata).toMatchObject({ model: "model-x", inputTokens: 10, outputTokens: 5, providerResponseId: "resp_1" });
      expect(rows[1]?.metadata).toMatchObject({ errorName: "Error" });
      const stored = JSON.stringify(rows);
      expect(stored).not.toContain(OPENAI_SECRET);
      expect(stored).not.toContain("never stored");
    });
  });

  describe("one correlated trace across the HTTP request, the outbox, n8n and the discovery stage", () => {
    let app: INestApplication;
    let manager: ReturnType<typeof request.agent>;
    let loggedErrors: string[] = [];
    let providerFailure: Error | null = null;
    let providerCalls = 0;
    const n8nHeaders: Array<Record<string, string>> = [];

    const signed = (path: string, correlationId: string) => {
      return request(app.getHttpServer())
        .post(path)
        .set(serviceHeaders("POST", path))
        .set("x-correlation-id", correlationId);
    };

    beforeAll(async () => {
      const passwordHash = await new PasswordHasher().hash(password);
      const role = await database.role.upsert({ where: { name: "MANAGER" }, create: { name: "MANAGER" }, update: {} });
      await database.user.create({ data: { email: managerEmail, passwordHash, roles: { create: { roleId: role.id } } } });
      app = await createApp();
      const adapter = app.get(OpenAISearchAdapter);
      adapter.plan = () => {
        providerCalls += 1;
        if (providerFailure) return Promise.reject(providerFailure);
        return Promise.resolve({
          data: { strategies: [{ type: "DIRECT_COMPANY", queries: ["Canada LiDAR survey companies"] }] },
          model: "stub",
          providerResponseId: "stub-plan",
          prompt: { name: "campaign-search-plan", version: "v1" },
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
      };
      adapter.search = () => {
        providerCalls += 1;
        return Promise.resolve({
          data: [
            {
              organizationName: `Trace Survey ${randomUUID().slice(0, 8)} Inc.`,
              organizationLocation: "Calgary, Alberta, Canada",
              websiteUrl: `https://trace-${randomUUID().slice(0, 8)}.example/services`,
              sourceUrl: `https://evidence.example/${randomUUID().slice(0, 8)}`,
              sourceTitle: "Stubbed result",
              summary: "Stubbed organization.",
              evidenceSnippet: "Stubbed evidence.",
              strategyType: "DIRECT_COMPANY",
              query: "Canada LiDAR survey companies",
            },
          ],
          model: "stub",
          providerResponseId: "stub-search",
          prompt: { name: "campaign-search-discovery", version: "v1" },
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        });
      };
      await app.init();
      manager = request.agent(app.getHttpServer());
      await manager.post("/auth/login").send({ email: managerEmail, password }).expect(200);

      // Stand-in for n8n: remembers the headers it received and answers like the real webhook.
      const realFetch = globalThis.fetch;
      vi.stubGlobal("fetch", (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        if (String(input).startsWith("http://n8n.test/")) {
          n8nHeaders.push(Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)));
          return Promise.resolve(Response.json({ executionId: "exec-trace-1" }));
        }
        return realFetch(input, init);
      });
    });

    afterAll(async () => {
      await app?.close();
    });

    beforeEach(() => {
      loggedErrors = [];
      providerFailure = null;
      providerCalls = 0;
      n8nHeaders.length = 0;
      // pino writes straight to the file descriptor, so capture what the error filter hands to the logger.
      vi.spyOn(PinoLogger.prototype, "error").mockImplementation((...args: unknown[]) => {
        loggedErrors.push(JSON.stringify(args));
      });
    });

    it("links the request, the outbox event, the call to n8n, the stage run and every audit row by one correlation ID", async () => {
      const campaign = await seedCampaign("DRAFT");
      const correlationId = "trace-http-000001";
      const started = await manager
        .post(`/campaigns/${campaign.id}/start`)
        .set("origin", "http://localhost:3000")
        .set("x-correlation-id", correlationId)
        .expect(201);
      expect(started.headers["x-correlation-id"]).toBe(correlationId);

      const event = await database.outboxEvent.findFirstOrThrow({ where: { aggregateId: campaign.id } });
      expect(event.correlationId).toBe(correlationId);
      expect(n8nHeaders[0]?.["x-correlation-id"]).toBe(correlationId);

      // n8n forwards the header it received when it calls NestJS back.
      await signed(`/internal/campaigns/${campaign.id}/prepare-discovery`, n8nHeaders[0]?.["x-correlation-id"] ?? "missing")
        .expect((response) => expect(response.status).toBeLessThan(300));

      const run = await database.stageRun.findFirstOrThrow({ where: { campaignId: campaign.id } });
      expect(run).toMatchObject({ correlationId, status: "SUCCEEDED" });

      const rows = await database.auditLog.findMany({ where: { campaignId: campaign.id }, orderBy: { createdAt: "asc" } });
      expect(new Set(rows.map((row) => row.correlationId))).toEqual(new Set([correlationId]));
      expect(rows.map((row) => row.action)).toEqual(
        expect.arrayContaining(["campaign.start_requested", "campaign.started", "stage.transitioned", "provider.call"]),
      );
      const stored = JSON.stringify([event, run, rows]);
      for (const secret of [serviceSecret, OPENAI_SECRET]) expect(stored).not.toContain(secret);
      expect(loggedErrors.join("")).not.toContain(serviceSecret);

      // PH1-03a: the same request reserved and settled both OpenAI calls in the usage ledger,
      // under the stage run and the campaign start event, through the production caller.
      const usage = await database.providerUsage.findMany({ where: { campaignId: campaign.id }, orderBy: { reservedAt: "asc" } });
      expect(usage.map((row) => [row.operation, row.status, row.stageRunId, row.runId])).toEqual([
        ["search-plan", "SETTLED", run.id, event.id],
        ["web-search", "SETTLED", run.id, event.id],
      ]);
      expect(JSON.stringify(usage)).not.toContain(OPENAI_SECRET);
    });

    it("traces a provider failure that echoes a secret to the campaign and stage without leaking it anywhere", async () => {
      const campaign = await seedCampaign("RUNNING");
      await database.outboxEvent.create({
        data: {
          eventType: "CAMPAIGN_STARTED",
          aggregateType: "campaign",
          aggregateId: campaign.id,
          idempotencyKey: `campaign-start:${campaign.id}`,
          payload: { campaignId: campaign.id },
        },
      });
      providerFailure = new Error(`Incorrect API key provided: ${OPENAI_SECRET}. Authorization: Bearer abcdefghijklmnopqrstuvwx`);
      const correlationId = "trace-fail-000001";
      const response = await signed(`/internal/campaigns/${campaign.id}/prepare-discovery`, correlationId).expect(500);

      expect(response.body).toMatchObject({ correlationId, message: "An unexpected error occurred" });
      const run = await database.stageRun.findFirstOrThrow({ where: { campaignId: campaign.id } });
      expect(run).toMatchObject({ status: "PENDING", correlationId });
      const rows = await database.auditLog.findMany({ where: { campaignId: campaign.id } });
      const providerRow = rows.find((row) => row.action === "provider.call");
      expect(providerRow?.metadata).toMatchObject({ status: "FAILED", errorName: "Error" });
      expect(rows.every((row) => row.correlationId === correlationId)).toBe(true);

      const everything = JSON.stringify([response.body, run, rows]) + loggedErrors.join("");
      for (const secret of [OPENAI_SECRET, "abcdefghijklmnopqrstuvwx", serviceSecret]) expect(everything).not.toContain(secret);
      // The failure is still diagnosable: the log names the correlation ID and the request.
      expect(loggedErrors.join("")).toContain(correlationId);
      expect(providerCalls).toBe(1);

      // The failed call may have been charged, so it stays counted at the estimate with an unknown cost.
      const usage = await database.providerUsage.findMany({ where: { campaignId: campaign.id } });
      expect(usage).toHaveLength(1);
      expect(usage[0]).toMatchObject({ status: "SETTLED", costKnown: false, outcomeCode: "FAILED_COST_UNKNOWN" });
      expect(JSON.stringify(usage)).not.toContain(OPENAI_SECRET);
    });
  });
});
