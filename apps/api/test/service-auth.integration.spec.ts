import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import { Logger, type INestApplication } from "@nestjs/common";
import { ModulesContainer, Reflector } from "@nestjs/core";
import { createPrismaClient } from "@tcpl-marketer/database";
import {
  SERVICE_CALLERS,
  SERVICE_SCOPES,
  buildServiceCanonicalString,
  isValidServiceRequestId,
  type ServiceCallerId,
  type ServiceScope,
} from "@tcpl-marketer/orchestration-contracts";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/bootstrap.js";
import { ServiceAuthGuard } from "../src/common/service-auth.guard.js";
import {
  MAX_REJECTION_ROWS_PER_DAY,
  MAX_REJECTION_ROWS_PER_MINUTE,
  RejectionAuditLimiter,
  ServiceAuthRejectionsService,
} from "../src/common/service-auth/service-auth-rejections.service.js";
import {
  readMaxSkewSeconds,
  replayRetentionSeconds,
  validateServiceAuthEnvironment,
} from "../src/common/service-auth/service-auth.config.js";
import { ServiceReplayStore } from "../src/common/service-auth/service-replay.store.js";
import { SERVICE_SCOPE_KEY } from "../src/common/service-auth/service-scope.decorator.js";
import { OpenAISearchAdapter } from "../src/search/openai-search.adapter.js";
import { TEST_SERVICE_SECRETS, serviceHeaders } from "./support/service-auth.js";

// Private database per file, so these tests never touch the dev database or other files' rows.
const baseUrl = process.env.DATABASE_URL ?? "postgresql://app:app@localhost:5432/tcpl_marketer";
const databaseName = `tcpl_test_svcauth_${randomUUID().replaceAll("-", "")}`;
const privateUrl = new URL(baseUrl);
privateUrl.pathname = `/${databaseName}`;

const webhookSecret = "ph102b-webhook-secret-that-differs-from-signing";
const environmentKeys = [
  "DATABASE_URL",
  "DIRECT_URL",
  "N8N_SERVICE_SECRET",
  "N8N_BASE_URL",
  "OPENAI_API_KEY",
  "OUTBOX_DISPATCH_ENABLED",
  "SERVICE_AUTH_MAX_SKEW_SECONDS",
  "NODE_ENV",
] as const;
const saved: Record<string, string | undefined> = {};

describe("signed service requests (private PostgreSQL database)", () => {
  const admin = createPrismaClient(baseUrl);
  let database: ReturnType<typeof createPrismaClient>;
  let app: INestApplication;
  let providerCalls = 0;
  let userId = "";
  let sectorId = "";

  async function seedCampaign() {
    const campaign = await database.campaign.create({
      data: {
        name: `PH1-02b ${randomUUID()}`,
        sectorId,
        createdByUserId: userId,
        status: "RUNNING",
        researchDepth: "STANDARD",
        targetLeadCount: 3,
        minimumScore: 70,
        dailyEmailLimit: 10,
      },
    });
    await database.outboxEvent.create({
      data: {
        eventType: "CAMPAIGN_STARTED",
        aggregateType: "campaign",
        aggregateId: campaign.id,
        idempotencyKey: `campaign-start:${campaign.id}`,
        payload: { campaignId: campaign.id },
      },
    });
    return campaign;
  }

  const discoveryPath = (id: string) => `/internal/campaigns/${id}/prepare-discovery`;
  const contextPath = (id: string) => `/internal/campaigns/${id}/context`;
  const server = () => request(app.getHttpServer());
  const sideEffects = async () => ({
    providerCalls,
    stageRuns: await database.stageRun.count(),
    candidates: await database.leadCandidate.count(),
    nonces: await database.serviceRequestNonce.count(),
  });

  beforeAll(async () => {
    for (const key of environmentKeys) saved[key] = process.env[key];
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    process.env.DATABASE_URL = privateUrl.toString();
    process.env.DIRECT_URL = privateUrl.toString();
    process.env.N8N_SERVICE_SECRET = webhookSecret;
    process.env.N8N_BASE_URL = "http://n8n.test";
    process.env.OPENAI_API_KEY = "disabled-for-service-auth-test";
    process.env.OUTBOX_DISPATCH_ENABLED = "false";
    delete process.env.SERVICE_AUTH_MAX_SKEW_SECONDS;
    execSync("pnpm --filter @tcpl-marketer/database exec prisma migrate deploy", { env: process.env, stdio: "ignore" });
    database = createPrismaClient(privateUrl.toString());
    userId = (await database.user.create({ data: { email: `ph102b-${randomUUID()}@example.test`, passwordHash: "unused" } })).id;
    sectorId = (await database.sector.create({ data: { name: "PH1-02b sector", slug: `ph102b-${randomUUID()}` } })).id;

    app = await createApp();
    const adapter = app.get(OpenAISearchAdapter);
    adapter.plan = () => {
      providerCalls += 1;
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
      const suffix = randomUUID().slice(0, 8);
      return Promise.resolve({
        data: [
          {
            organizationName: `Auth Survey ${suffix} Inc.`,
            organizationLocation: "Calgary, Alberta, Canada",
            websiteUrl: `https://auth-${suffix}.example/services`,
            sourceUrl: `https://evidence.example/${suffix}`,
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
    // Listen once on a real port. With only init(), every supertest call starts the same server itself and the first
    // call to finish closes it under the others, which resets requests still in flight on a slower machine.
    await app.listen(0, "127.0.0.1");
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await database?.$disconnect();
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.$disconnect();
    for (const key of environmentKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  beforeEach(async () => {
    delete process.env.SERVICE_AUTH_MAX_SKEW_SECONDS;
    // Each test gets its own rejection budget; the limiter has its own tests below.
    const rejections = app.get(ServiceAuthRejectionsService) as unknown as { limiter: RejectionAuditLimiter };
    rejections.limiter = new RejectionAuditLimiter(10_000, 10_000);
    await database.auditLog.deleteMany({ where: { action: "service_auth.rejected" } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs a valid signed request once and rejects an identical replay before the handler", async () => {
    const campaign = await seedCampaign();
    const path = discoveryPath(campaign.id);
    const headers = serviceHeaders("POST", path);
    const before = await sideEffects();

    await server().post(path).set(headers).expect(201);
    const afterFirst = await sideEffects();
    expect(afterFirst.providerCalls).toBe(before.providerCalls + 2);
    expect(afterFirst.nonces).toBe(before.nonces + 1);

    const replay = await server().post(path).set(headers).expect(401);
    expect(replay.body.message).toBe("Invalid service signature");
    expect(await sideEffects()).toEqual(afterFirst);
    const row = await database.auditLog.findFirstOrThrow({ where: { action: "service_auth.rejected" } });
    expect(row.metadata).toMatchObject({ reason: "REPLAYED", caller: "n8n-campaign-start", scope: "campaign.discovery.prepare", method: "POST", path });
  });

  it("runs exactly one of many concurrent identical requests", async () => {
    const campaign = await seedCampaign();
    const path = discoveryPath(campaign.id);
    const headers = serviceHeaders("POST", path);
    const before = providerCalls;
    const responses = await Promise.all(Array.from({ length: 12 }, () => server().post(path).set(headers)));
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses.filter((status) => status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 401)).toHaveLength(11);
    expect(providerCalls).toBe(before + 2);
  });

  it("treats a re-published event as new requests with the same idempotent outcome", async () => {
    const campaign = await seedCampaign();
    const path = discoveryPath(campaign.id);
    const first = await server().post(path).set(serviceHeaders("POST", path)).expect(201);
    const calls = providerCalls;
    const second = await server().post(path).set(serviceHeaders("POST", path)).expect(201);
    expect(second.body).toEqual(first.body);
    expect(providerCalls).toBe(calls);
    expect(await database.stageRun.count({ where: { campaignId: campaign.id } })).toBe(1);
  });

  describe("negative matrix: every case fails closed with no side effect", () => {
    type Case = { name: string; status: number; reason: string; build: (path: string, otherPath: string) => Record<string, string> };
    const without = (headers: Record<string, string>, name: string) => {
      const copy = { ...headers };
      delete copy[name];
      return copy;
    };
    const cases: Case[] = [
      { name: "unsigned", status: 401, reason: "MISSING_HEADERS", build: () => ({}) },
      { name: "no key ID", status: 401, reason: "MISSING_HEADERS", build: (p) => without(serviceHeaders("POST", p), "x-service-key-id") },
      { name: "no request ID", status: 401, reason: "MISSING_HEADERS", build: (p) => without(serviceHeaders("POST", p), "x-service-request-id") },
      { name: "no timestamp", status: 401, reason: "MISSING_HEADERS", build: (p) => without(serviceHeaders("POST", p), "x-service-timestamp") },
      { name: "no signature", status: 401, reason: "MISSING_HEADERS", build: (p) => without(serviceHeaders("POST", p), "x-service-signature") },
      { name: "signature not hex", status: 401, reason: "MALFORMED_HEADERS", build: (p) => ({ ...serviceHeaders("POST", p), "x-service-signature": "z".repeat(64) }) },
      { name: "signature wrong length", status: 401, reason: "MALFORMED_HEADERS", build: (p) => ({ ...serviceHeaders("POST", p), "x-service-signature": "ab".repeat(16) }) },
      { name: "timestamp not numeric", status: 401, reason: "MALFORMED_HEADERS", build: (p) => ({ ...serviceHeaders("POST", p), "x-service-timestamp": "1e12" }) },
      { name: "malformed request ID", status: 401, reason: "MALFORMED_HEADERS", build: (p) => serviceHeaders("POST", p, { requestId: "bad id" }) },
      { name: "wrong secret", status: 401, reason: "BAD_SIGNATURE", build: (p) => serviceHeaders("POST", p, { secret: "a-completely-different-secret-value-000" }) },
      { name: "another caller's secret", status: 401, reason: "BAD_SIGNATURE", build: (p) => serviceHeaders("POST", p, { caller: "n8n-campaign-start", secret: TEST_SERVICE_SECRETS["n8n-outbox-dispatch"] }) },
      { name: "the webhook secret", status: 401, reason: "BAD_SIGNATURE", build: (p) => serviceHeaders("POST", p, { secret: webhookSecret }) },
      { name: "unknown key ID", status: 401, reason: "UNKNOWN_CALLER", build: (p) => serviceHeaders("POST", p, { caller: "n8n-unknown" as ServiceCallerId, secret: "x".repeat(40) }) },
      { name: "wrong caller for this endpoint", status: 403, reason: "WRONG_SCOPE", build: (p) => serviceHeaders("POST", p, { caller: "n8n-outbox-dispatch" }) },
      { name: "tooling caller on a workflow endpoint", status: 403, reason: "WRONG_SCOPE", build: (p) => serviceHeaders("POST", p, { caller: "internal-tooling" }) },
      { name: "signed for another path", status: 401, reason: "BAD_SIGNATURE", build: (_p, other) => serviceHeaders("POST", other, { caller: "n8n-campaign-start" }) },
      { name: "signed for another method", status: 401, reason: "BAD_SIGNATURE", build: (p) => serviceHeaders("GET", p, { caller: "n8n-campaign-start" }) },
      { name: "signed with a query string", status: 401, reason: "BAD_SIGNATURE", build: (p) => serviceHeaders("POST", `${p}?x=1`, { caller: "n8n-campaign-start" }) },
      { name: "signed with a body that was not sent", status: 401, reason: "BAD_SIGNATURE", build: (p) => serviceHeaders("POST", p, { body: "{}" }) },
      { name: "signed for different diagnostic headers", status: 401, reason: "BAD_SIGNATURE", build: (p) => ({ ...serviceHeaders("POST", p), "x-f001-diagnostic-run-id": randomUUID() }) },
      { name: "expired", status: 401, reason: "EXPIRED_TIMESTAMP", build: (p) => serviceHeaders("POST", p, { timestamp: String(Date.now() - 301_000) }) },
      { name: "future-dated", status: 401, reason: "FUTURE_TIMESTAMP", build: (p) => serviceHeaders("POST", p, { timestamp: String(Date.now() + 301_000) }) },
    ];

    it.each(cases)("$name", async ({ status, reason, build }) => {
      const campaign = await seedCampaign();
      const other = await seedCampaign();
      const path = discoveryPath(campaign.id);
      const headers = build(path, discoveryPath(other.id));
      const before = await sideEffects();
      const response = await server().post(path).set(headers).expect(status);
      expect(await sideEffects()).toEqual(before);
      expect(response.body.message).toBe(
        status === 401 ? "Invalid service signature" : "Service caller is not allowed to use this endpoint",
      );
      const row = await database.auditLog.findFirstOrThrow({ where: { action: "service_auth.rejected" } });
      expect((row.metadata as { reason: string }).reason).toBe(reason);
      const stored = JSON.stringify(row);
      expect(stored).not.toContain(headers["x-service-signature"] ?? "no-signature-sent");
      for (const secret of Object.values(TEST_SERVICE_SECRETS)) expect(stored).not.toContain(secret);
    });

    it("rejects a tampered body and accepts only the exact bytes that were signed", async () => {
      const organizationId = randomUUID();
      const path = `/internal/organizations/${organizationId}/company-fit`;
      const signedBody = JSON.stringify({ observations: [] });
      const send = (headers: Record<string, string>, body: string) =>
        server().post(path).set(headers).set("content-type", "application/json").send(body);

      await send(serviceHeaders("POST", path, { body: signedBody }), JSON.stringify({ observations: [{}] })).expect(401);
      // Same JSON meaning, different bytes: the body is never re-serialized.
      await send(serviceHeaders("POST", path, { body: signedBody }), '{ "observations": [] }').expect(401);
      // The exact bytes pass authentication and reach schema validation.
      await send(serviceHeaders("POST", path, { body: signedBody }), signedBody).expect(400);
    });

    it("rejects a body the verifier cannot read, including compressed and unparsed bodies", async () => {
      const campaign = await seedCampaign();
      const path = discoveryPath(campaign.id);
      const before = await sideEffects();
      await server().post(path).set(serviceHeaders("POST", path)).set("content-type", "text/plain").send("injected").expect(401);
      await server()
        .post(path)
        .set(serviceHeaders("POST", path, { body: "{}" }))
        .set("content-type", "application/json")
        .set("content-encoding", "gzip")
        .serialize(() => gzipSync("{}") as unknown as string)
        .send({})
        .expect(401);
      expect(await sideEffects()).toEqual(before);
      const reasons = await database.auditLog.findMany({ where: { action: "service_auth.rejected" } });
      expect(reasons.map((row) => (row.metadata as { reason: string }).reason)).toEqual(["UNVERIFIABLE_BODY", "UNVERIFIABLE_BODY"]);
    });

    it("binds the headers that change handler behaviour", async () => {
      const path = `/internal/lead-candidates/${randomUUID()}/research`;
      const diagnosticRunId = randomUUID();
      const inputHash = "a".repeat(64);
      const signed = serviceHeaders("POST", path, { diagnosticRunId, inputHash });
      await server().post(path).set({ ...signed, "x-f001-input-hash": "b".repeat(64) }).expect(401);
      // Unknown candidate: authentication passed and the handler answered.
      await server().post(path).set(serviceHeaders("POST", path, { diagnosticRunId, inputHash })).expect(404);
    });
  });

  it("accepts clock difference inside the configured tolerance on both sides and rejects it outside", async () => {
    process.env.SERVICE_AUTH_MAX_SKEW_SECONDS = "30";
    const campaign = await seedCampaign();
    const path = contextPath(campaign.id);
    await server().get(path).set(serviceHeaders("GET", path, { timestamp: String(Date.now() - 25_000) })).expect(200);
    await server().get(path).set(serviceHeaders("GET", path, { timestamp: String(Date.now() + 25_000) })).expect(200);
    await server().get(path).set(serviceHeaders("GET", path, { timestamp: String(Date.now() - 35_000) })).expect(401);
    await server().get(path).set(serviceHeaders("GET", path, { timestamp: String(Date.now() + 35_000) })).expect(401);
  });

  it("accepts the previous secret only during a rotation", async () => {
    const campaign = await seedCampaign();
    const path = contextPath(campaign.id);
    const name = SERVICE_CALLERS["n8n-campaign-start"].secretEnv;
    const oldSecret = TEST_SERVICE_SECRETS["n8n-campaign-start"];
    const newSecret = "rotated-campaign-start-secret-0123456789abcd";
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    process.env[name] = newSecret;
    process.env[`${name}_PREVIOUS`] = oldSecret;
    try {
      await server().get(path).set(serviceHeaders("GET", path, { secret: oldSecret })).expect(200);
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: "Service caller used its rotating-out secret", caller: "n8n-campaign-start" }));
      await server().get(path).set(serviceHeaders("GET", path, { secret: newSecret })).expect(200);
      delete process.env[`${name}_PREVIOUS`];
      await server().get(path).set(serviceHeaders("GET", path, { secret: oldSecret })).expect(401);
      await server().get(path).set(serviceHeaders("GET", path, { secret: newSecret })).expect(200);
    } finally {
      process.env[name] = oldSecret;
      delete process.env[`${name}_PREVIOUS`];
    }
  });

  it("fails closed when the replay store is unavailable", async () => {
    const campaign = await seedCampaign();
    const path = discoveryPath(campaign.id);
    vi.spyOn(app.get(ServiceReplayStore), "consume").mockRejectedValueOnce(new Error("database down"));
    const before = providerCalls;
    await server().post(path).set(serviceHeaders("POST", path)).expect(503);
    expect(providerCalls).toBe(before);
    expect(await database.stageRun.count({ where: { campaignId: campaign.id } })).toBe(0);
  });

  it("fails closed when no service secret is configured", async () => {
    const campaign = await seedCampaign();
    const path = contextPath(campaign.id);
    const headers = serviceHeaders("GET", path);
    const names = Object.values(SERVICE_CALLERS).map((caller) => caller.secretEnv);
    const values = names.map((name) => process.env[name]);
    for (const name of names) delete process.env[name];
    try {
      await server().get(path).set(headers).expect(503);
    } finally {
      names.forEach((name, index) => {
        process.env[name] = values[index];
      });
    }
  });

  it("closes a route that declares no scope", async () => {
    const guard = app.get(ServiceAuthGuard);
    const handler = () => undefined;
    class NoScopeController {}
    const context = {
      getHandler: () => handler,
      getClass: () => NoScopeController,
      switchToHttp: () => ({
        getRequest: () => ({ headers: serviceHeaders("GET", "/internal/x"), method: "GET", originalUrl: "/internal/x" }),
      }),
    };
    await expect(guard.canActivate(context as never)).rejects.toMatchObject({ status: 403 });
  });

  describe("route inventory", () => {
    function internalRoutes() {
      const reflector = new Reflector();
      const routes: Array<{ name: string; method: string; path: string; guarded: boolean; scope: ServiceScope | undefined }> = [];
      for (const module of app.get(ModulesContainer).values()) {
        for (const { metatype } of module.controllers.values()) {
          if (typeof metatype !== "function") continue;
          const prefix = String(Reflect.getMetadata("path", metatype) ?? "");
          if (!/^\/?internal(\/|$)/.test(prefix)) continue;
          const classGuards = (Reflect.getMetadata("__guards__", metatype) ?? []) as unknown[];
          for (const key of Object.getOwnPropertyNames(metatype.prototype)) {
            const handler = (metatype.prototype as Record<string, unknown>)[key];
            if (key === "constructor" || typeof handler !== "function") continue;
            const routePath = Reflect.getMetadata("path", handler) as string | undefined;
            if (routePath === undefined) continue;
            const methodGuards = (Reflect.getMetadata("__guards__", handler) ?? []) as unknown[];
            routes.push({
              name: `${metatype.name}.${key}`,
              method: ["GET", "POST", "PUT", "DELETE", "PATCH"][Reflect.getMetadata("method", handler) as number] ?? "UNKNOWN",
              path: `/${prefix}/${routePath}`.replace(/\/+/g, "/"),
              guarded: [...classGuards, ...methodGuards].includes(ServiceAuthGuard),
              scope: reflector.getAllAndOverride<ServiceScope | undefined>(SERVICE_SCOPE_KEY, [handler as never, metatype]),
            });
          }
        }
      }
      return routes;
    }

    it("finds all internal routes, each with the guard and a known scope", () => {
      const routes = internalRoutes();
      expect(routes.length).toBe(11);
      for (const route of routes) {
        expect(route.guarded, `${route.name} has no ServiceAuthGuard`).toBe(true);
        expect(route.scope, `${route.name} declares no scope`).toBeDefined();
        expect(SERVICE_SCOPES).toContain(route.scope);
      }
    });

    it("has no unused scope and no scope granted to a caller without a route", () => {
      const used = new Set(internalRoutes().map((route) => route.scope));
      expect(new Set(SERVICE_SCOPES)).toEqual(used);
      for (const caller of Object.values(SERVICE_CALLERS)) {
        for (const scope of caller.scopes) expect(used.has(scope)).toBe(true);
      }
    });

    it("lets each caller reach exactly the routes in its scope list", async () => {
      process.env.OUTBOX_DISPATCH_ENABLED = "false";
      for (const route of internalRoutes()) {
        const path = route.path.replace(":id", randomUUID());
        for (const caller of Object.keys(SERVICE_CALLERS) as ServiceCallerId[]) {
          const allowed = (SERVICE_CALLERS[caller].scopes as readonly string[]).includes(route.scope as string);
          const body = route.path.endsWith("company-fit") && route.method === "POST" ? "{}" : undefined;
          const call = route.method === "GET" ? server().get(path) : server().post(path);
          call.set(serviceHeaders(route.method, path, { caller, ...(body ? { body } : {}) }));
          if (body) call.set("content-type", "application/json").send(body);
          const response = await call;
          if (allowed) expect([401, 403], `${caller} ${route.name}`).not.toContain(response.status);
          else expect(response.status, `${caller} ${route.name}`).toBe(403);
        }
      }
    });
  });

  describe("replay storage", () => {
    it("keeps a nonce longer than any accepted timestamp can live", () => {
      expect(replayRetentionSeconds(300)).toBeGreaterThan(600);
    });

    it("removes only expired rows, in bounded batches", async () => {
      const store = app.get(ServiceReplayStore);
      await database.serviceRequestNonce.deleteMany({});
      await database.$executeRawUnsafe(
        `INSERT INTO service_request_nonces (caller_id, request_id, expires_at)
         SELECT 'internal-tooling', 'expired-' || n, now() - interval '1 minute' FROM generate_series(1, 25) n`,
      );
      await database.$executeRawUnsafe(
        `INSERT INTO service_request_nonces (caller_id, request_id, expires_at)
         SELECT 'internal-tooling', 'live-' || n, now() + interval '1 hour' FROM generate_series(1, 3) n`,
      );
      expect(await store.removeExpired(10, 2)).toBe(20);
      expect(await database.serviceRequestNonce.count()).toBe(8);
      expect(await store.removeExpired(10, 5)).toBe(5);
      expect(await database.serviceRequestNonce.count()).toBe(3);
    });

    it("scopes a request ID to its caller", async () => {
      const store = app.get(ServiceReplayStore);
      const id = `shared-${randomUUID()}`;
      expect(await store.consume("n8n-campaign-start", id)).toBe(true);
      expect(await store.consume("n8n-company-research", id)).toBe(true);
      expect(await store.consume("n8n-campaign-start", id)).toBe(false);
    });
  });

  describe("rejection audit volume", () => {
    it("caps rows per minute and per day and reports how many were suppressed", () => {
      let clock = 1_000_000;
      const limiter = new RejectionAuditLimiter(2, 5, () => clock);
      expect([limiter.admit(), limiter.admit(), limiter.admit(), limiter.admit()]).toEqual([0, 0, null, null]);
      clock += 60_000;
      expect(limiter.admit()).toBe(2);
      expect(limiter.admit()).toBe(0);
      clock += 60_000;
      expect(limiter.admit()).toBe(0);
      expect(limiter.admit()).toBeNull();
      clock += 60_000;
      expect(limiter.admit()).toBeNull();
      clock += 86_400_000;
      expect(limiter.admit()).toBe(2);
      expect(MAX_REJECTION_ROWS_PER_MINUTE).toBeLessThanOrEqual(MAX_REJECTION_ROWS_PER_DAY);
    });

    it("writes no more than the limit during a flood of unsigned requests", async () => {
      const rejections = app.get(ServiceAuthRejectionsService) as unknown as { limiter: RejectionAuditLimiter };
      rejections.limiter = new RejectionAuditLimiter(5, 100);
      const campaign = await seedCampaign();
      const path = contextPath(campaign.id);
      // Thirty unsigned requests in bursts of ten: well over the limit of five rows, without opening thirty connections at once.
      for (let burst = 0; burst < 3; burst += 1) {
        await Promise.all(Array.from({ length: 10 }, () => server().get(path).expect(401)));
      }
      expect(await database.auditLog.count({ where: { action: "service_auth.rejected" } })).toBe(5);
    });

    it("stores no query string, so nothing secret in a URL reaches the audit row", async () => {
      const campaign = await seedCampaign();
      const path = `${contextPath(campaign.id)}?token=never-store-this-value`;
      await server().get(path).expect(401);
      const row = await database.auditLog.findFirstOrThrow({ where: { action: "service_auth.rejected" } });
      expect(JSON.stringify(row)).not.toContain("never-store-this-value");
    });
  });

  describe("startup validation", () => {
    const good = {
      SERVICE_SECRET_N8N_CAMPAIGN_START: "a".repeat(40),
      SERVICE_SECRET_N8N_COMPANY_RESEARCH: "b".repeat(40),
      SERVICE_SECRET_N8N_OUTBOX_DISPATCH: "c".repeat(40),
      SERVICE_SECRET_INTERNAL_TOOLING: "d".repeat(40),
      N8N_SERVICE_SECRET: "e".repeat(40),
    };

    it("accepts a complete configuration in production", () => {
      expect(validateServiceAuthEnvironment({ ...good, NODE_ENV: "production" })).toEqual({ missing: [] });
    });

    it("fails closed on a missing secret outside development and test, without printing values", () => {
      const environment: NodeJS.ProcessEnv = { ...good, NODE_ENV: "production" };
      delete environment.SERVICE_SECRET_N8N_OUTBOX_DISPATCH;
      expect(() => validateServiceAuthEnvironment(environment)).toThrow(/SERVICE_SECRET_N8N_OUTBOX_DISPATCH/);
      const unset: NodeJS.ProcessEnv = { ...environment };
      delete unset.NODE_ENV;
      expect(() => validateServiceAuthEnvironment(unset)).toThrow(/Missing service secrets/);
      expect(validateServiceAuthEnvironment({ ...environment, NODE_ENV: "development" }).missing).toEqual(["SERVICE_SECRET_N8N_OUTBOX_DISPATCH"]);
    });

    it("rejects weak, reused and misplaced secrets in every environment", () => {
      const secretValue = "weak";
      for (const NODE_ENV of ["development", "test", "production"]) {
        let message = "";
        try {
          validateServiceAuthEnvironment({ ...good, NODE_ENV, SERVICE_SECRET_INTERNAL_TOOLING: secretValue });
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toMatch(/at least 32/);
        expect(message).not.toContain(`${secretValue} `);
        expect(() => validateServiceAuthEnvironment({ ...good, NODE_ENV, SERVICE_SECRET_INTERNAL_TOOLING: good.SERVICE_SECRET_N8N_CAMPAIGN_START })).toThrow(/must differ/);
        expect(() => validateServiceAuthEnvironment({ ...good, NODE_ENV, SERVICE_SECRET_INTERNAL_TOOLING: good.N8N_SERVICE_SECRET })).toThrow(/N8N_SERVICE_SECRET/);
        const noCurrent: NodeJS.ProcessEnv = { ...good, NODE_ENV, SERVICE_SECRET_INTERNAL_TOOLING_PREVIOUS: "f".repeat(40) };
        delete noCurrent.SERVICE_SECRET_INTERNAL_TOOLING;
        expect(() => validateServiceAuthEnvironment(noCurrent)).toThrow(/without/);
      }
    });

    it("validates the clock tolerance", () => {
      expect(readMaxSkewSeconds({})).toBe(300);
      expect(readMaxSkewSeconds({ SERVICE_AUTH_MAX_SKEW_SECONDS: "60" })).toBe(60);
      for (const value of ["0", "9", "901", "abc", "1.5"]) {
        expect(() => readMaxSkewSeconds({ SERVICE_AUTH_MAX_SKEW_SECONDS: value })).toThrow(/SERVICE_AUTH_MAX_SKEW_SECONDS/);
      }
    });

    it("refuses to start in production when a caller has no secret", async () => {
      const name = SERVICE_CALLERS["internal-tooling"].secretEnv;
      const value = process.env[name];
      process.env.NODE_ENV = "production";
      delete process.env[name];
      let starting: INestApplication | undefined;
      try {
        starting = await createApp();
        await expect(starting.init()).rejects.toThrow(/Missing service secrets/);
      } finally {
        process.env[name] = value;
        process.env.NODE_ENV = saved.NODE_ENV;
        await starting?.close().catch(() => undefined);
      }
    });
  });

  describe("the versioned workflows match the verifier", () => {
    it("builds the same canonical string and uses each workflow's own secret", async () => {
      const { readFile } = await import("node:fs/promises");
      const expected: Record<string, { caller: ServiceCallerId; signers: number }> = {
        "campaign-start": { caller: "n8n-campaign-start", signers: 2 },
        "company-research": { caller: "n8n-company-research", signers: 3 },
        "outbox-dispatch": { caller: "n8n-outbox-dispatch", signers: 1 },
      };
      const sample = buildServiceCanonicalString({ keyId: "k", timestamp: "t", requestId: "r", method: "post", path: "/p", bodySha256: "h" });
      expect(sample.split("\n")).toEqual(["TCPL-HMAC-SHA256-V2", "k", "t", "r", "POST", "/p", "h", "", ""]);
      for (const [name, { caller, signers }] of Object.entries(expected)) {
        const workflow = JSON.parse(await readFile(new URL(`../../../automation/n8n/workflows/${name}.json`, import.meta.url), "utf8")) as {
          nodes: Array<{ type: string; parameters: { value?: string; secret?: string; headerParameters?: { parameters: Array<{ name: string; value: string }> } } }>;
        };
        const crypto = workflow.nodes.filter((node) => node.type.endsWith(".crypto"));
        expect(crypto).toHaveLength(signers);
        for (const node of crypto) {
          expect(node.parameters.secret).toBe(`={{ $env.${SERVICE_CALLERS[caller].secretEnv} }}`);
          expect(node.parameters.value).toContain(`['TCPL-HMAC-SHA256-V2', '${caller}',`);
        }
        const http = workflow.nodes.filter((node) => node.type.endsWith(".httpRequest"));
        expect(http).toHaveLength(signers);
        for (const node of http) {
          const headers = node.parameters.headerParameters?.parameters ?? [];
          expect(headers.find((header) => header.name === "x-service-key-id")?.value).toBe(caller);
          for (const required of ["x-service-timestamp", "x-service-request-id", "x-service-signature"]) {
            expect(headers.some((header) => header.name === required)).toBe(true);
          }
        }
      }
      expect(isValidServiceRequestId("n8n-123-context-1700000000000-abc123de")).toBe(true);

      // Trace propagation: replies echo the ID and the scheduled tick issues its own.
      const load = async (name: string) =>
        JSON.parse(await readFile(new URL(`../../../automation/n8n/workflows/${name}.json`, import.meta.url), "utf8")) as {
          nodes: Array<{ name: string; type: string; parameters: Record<string, unknown> }>;
        };
      for (const name of ["campaign-start", "company-research"]) {
        const replies = (await load(name)).nodes.filter((node) => node.type.endsWith(".respondToWebhook"));
        expect(replies.length).toBeGreaterThan(0);
        for (const reply of replies) {
          expect(JSON.stringify(reply.parameters)).toContain('"name":"x-correlation-id"');
        }
      }
      const tick = await load("outbox-dispatch");
      const prepare = JSON.stringify(tick.nodes.find((node) => node.name === "Prepare Dispatch Request")?.parameters);
      const call = JSON.stringify(tick.nodes.find((node) => node.name === "Run Dispatch Tick in NestJS")?.parameters);
      expect(prepare).toContain("n8n-tick-");
      expect(call).toContain('"name":"x-correlation-id"');
    });
  });
});
