import { createHmac } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { createPrismaClient } from "@tcpl-marketer/database";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PasswordHasher } from "../src/auth/password-hasher.js";
import { createApp } from "../src/bootstrap.js";

const managerEmail = "d010-manager@example.test";
const password = "D010-Test-Password!2026";
const serviceSecret = "d010-test-service-secret-with-sufficient-entropy";
const database = createPrismaClient();
type TestAgent = ReturnType<typeof request.agent>;

describe("campaign orchestration", () => {
  let app: INestApplication | undefined;
  let manager: TestAgent;
  let userId: string | undefined;
  const campaignIds: string[] = [];
  let campaignInput: Record<string, unknown>;
  const originalBaseUrl = process.env.N8N_BASE_URL;
  const originalServiceSecret = process.env.N8N_SERVICE_SECRET;

  beforeAll(async () => {
    process.env.N8N_BASE_URL = "http://n8n.test";
    process.env.N8N_SERVICE_SECRET = serviceSecret;
    await database.user.deleteMany({ where: { email: managerEmail } });

    const role = await database.role.upsert({
      where: { name: "MANAGER" },
      create: { name: "MANAGER", description: "Campaign management" },
      update: {},
    });
    const user = await database.user.create({
      data: {
        email: managerEmail,
        displayName: "D010 Manager",
        passwordHash: await new PasswordHasher().hash(password),
        roles: { create: { roleId: role.id } },
      },
    });
    userId = user.id;

    const lidar = await database.sector.findUnique({
      where: { slug: "lidar" },
      include: {
        capabilities: {
          include: { deliverables: true, targetProfiles: true },
        },
      },
    });
    const capability = lidar?.capabilities[0];
    if (!lidar || !capability?.deliverables[0] || !capability.targetProfiles[0]) {
      throw new Error("Seeded LiDAR campaign configuration is required");
    }
    campaignInput = {
      name: "D010 Orchestration Campaign",
      sectorId: lidar.id,
      capabilityIds: [capability.id],
      deliverableIds: [capability.deliverables[0].id],
      targetClientProfileIds: [capability.targetProfiles[0].id],
      countries: ["United States"],
      states: [],
      cities: [],
      minimumEmployees: 10,
      maximumEmployees: 500,
      researchDepth: "STANDARD",
      targetLeadCount: 10,
      minimumScore: 70,
      automationMode: "MANUAL_REVIEW",
      dailyEmailLimit: 10,
      sequence: [{ stepNumber: 1, delayDays: 0 }],
    };

    app = await createApp();
    await app.init();
    manager = request.agent(app.getHttpServer());
    await manager
      .post("/auth/login")
      .send({ email: managerEmail, password })
      .expect(200);
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    try {
      if (campaignIds.length > 0) {
        await database.campaign.deleteMany({ where: { id: { in: campaignIds } } });
      }
      if (userId) {
        await database.auditLog.deleteMany({ where: { actorUserId: userId } });
        await database.user.deleteMany({ where: { id: userId } });
      }
      if (app) await app.close();
    } finally {
      if (originalBaseUrl === undefined) delete process.env.N8N_BASE_URL;
      else process.env.N8N_BASE_URL = originalBaseUrl;
      if (originalServiceSecret === undefined) delete process.env.N8N_SERVICE_SECRET;
      else process.env.N8N_SERVICE_SECRET = originalServiceSecret;
      vi.unstubAllGlobals();
      await database.$disconnect();
    }
  });

  it("durably publishes one campaign-start event and tracks the n8n run", async () => {
    const publish = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ executionId: "n8n-execution-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", publish);

    const created = await manager.post("/campaigns").send(campaignInput).expect(201);
    const campaignId = created.body.id as string;
    campaignIds.push(campaignId);

    const started = await manager.post(`/campaigns/${campaignId}/start`).expect(201);
    expect(started.body.campaign.status).toBe("RUNNING");
    expect(started.body.event).toMatchObject({
      eventType: "CAMPAIGN_STARTED",
      aggregateId: campaignId,
      status: "PUBLISHED",
      attempts: 1,
    });
    expect(started.body.automationRun).toMatchObject({
      provider: "n8n",
      externalRunId: "n8n-execution-1",
      status: "RUNNING",
      attempts: 1,
    });
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0]?.[0]).toBe(
      "http://n8n.test/webhook/campaign-start",
    );
    expect(publish.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: `Bearer ${serviceSecret}`,
    });

    const repeated = await manager.post(`/campaigns/${campaignId}/start`).expect(201);
    expect(repeated.body.event.id).toBe(started.body.event.id);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await database.outboxEvent.count({ where: { aggregateId: campaignId } })).toBe(1);
    expect(await database.automationRun.count({ where: { campaignId } })).toBe(1);
  });

  it("keeps a failed dispatch durable and retries the same event", async () => {
    const publish = vi
      .fn()
      .mockRejectedValueOnce(new Error("n8n unavailable"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ executionId: "n8n-execution-retry" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", publish);

    const created = await manager
      .post("/campaigns")
      .send({ ...campaignInput, name: "D010 Retry Campaign" })
      .expect(201);
    const campaignId = created.body.id as string;
    campaignIds.push(campaignId);

    await manager.post(`/campaigns/${campaignId}/start`).expect(502);
    const pending = await database.outboxEvent.findUniqueOrThrow({
      where: { idempotencyKey: `campaign-start:${campaignId}` },
      include: { automationRun: true },
    });
    expect(pending).toMatchObject({ status: "PENDING", attempts: 1 });
    expect(pending.automationRun).toMatchObject({ status: "FAILED", attempts: 1 });

    const retried = await manager.post(`/campaigns/${campaignId}/start`).expect(201);
    expect(retried.body.event.id).toBe(pending.id);
    expect(retried.body.event.attempts).toBe(2);
    expect(retried.body.automationRun).toMatchObject({
      status: "RUNNING",
      attempts: 2,
      externalRunId: "n8n-execution-retry",
    });
  });

  it("requires a fresh valid HMAC signature on the internal endpoint", async () => {
    const campaignId = campaignIds[0];
    expect(campaignId).toBeDefined();
    const path = `/internal/campaigns/${campaignId}/context`;
    await request(app!.getHttpServer()).get(path).expect(401);

    const timestamp = Date.now().toString();
    const signature = createHmac("sha256", serviceSecret)
      .update(`${timestamp}\nGET\n${path}`)
      .digest("hex");
    const response = await request(app!.getHttpServer())
      .get(path)
      .set("x-service-timestamp", timestamp)
      .set("x-service-signature", signature)
      .expect(200);
    expect(response.body).toMatchObject({ id: campaignId, status: "RUNNING" });
  });
});
