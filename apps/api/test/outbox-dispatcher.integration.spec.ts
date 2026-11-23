import { execSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { INestApplication } from "@nestjs/common";
import { createPrismaClient } from "@tcpl-marketer/database";
import {
  UnroutableOrchestrationEventError,
  type OrchestrationEvent,
  type OrchestrationGateway,
  type PublishResult,
} from "@tcpl-marketer/orchestration-contracts";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PasswordHasher } from "../src/auth/password-hasher.js";
import { createApp } from "../src/bootstrap.js";
import type { DatabaseService } from "../src/database/database.service.js";
import { DiscoveryStageService } from "../src/orchestration/discovery-stage.service.js";
import { N8nOrchestrationAdapter } from "../src/orchestration/n8n-orchestration.adapter.js";
import {
  computeRetryDelayMs,
  readOutboxDispatchConfig,
} from "../src/orchestration/outbox-dispatch.config.js";
import {
  OutboxDispatcherService,
  type ClaimedEvent,
  type DispatchOutcome,
} from "../src/orchestration/outbox-dispatcher.service.js";
import { PrismaCampaignStateReader } from "../src/orchestration/prisma-campaign-state-reader.js";
import { StageRunService } from "../src/orchestration/stage-run.service.js";
import type { SearchService } from "../src/search/search.service.js";

// The dispatcher claims any due event, so this file owns a private database and
// can never pick up events from parallel test files or from the dev database.
const baseUrl = process.env.DATABASE_URL ?? "postgresql://app:app@localhost:5432/tcpl_marketer";
const databaseName = `tcpl_test_dispatch_${randomUUID().replaceAll("-", "")}`;
const privateUrl = new URL(baseUrl);
privateUrl.pathname = `/${databaseName}`;

const serviceSecret = "ph101b-test-service-secret-with-sufficient-entropy";
const managerEmail = "ph101b-manager@example.test";
const memberEmail = "ph101b-member@example.test";
const password = "PH101b-Test-Password!2026";

const environmentKeys = [
  "DATABASE_URL",
  "DIRECT_URL",
  "N8N_SERVICE_SECRET",
  "N8N_BASE_URL",
  "OUTBOX_DISPATCH_ENABLED",
  "OUTBOX_MAX_ATTEMPTS",
  "OUTBOX_RETRY_BASE_MS",
  "OUTBOX_RETRY_MAX_MS",
  "OUTBOX_BATCH_SIZE",
] as const;

class FakeGateway implements OrchestrationGateway {
  calls: OrchestrationEvent[] = [];
  handler: (event: OrchestrationEvent) => Promise<PublishResult> = () =>
    Promise.resolve({ externalRunId: "fake-run" });

  async publish(event: OrchestrationEvent): Promise<PublishResult> {
    this.calls.push(event);
    return this.handler(event);
  }
  schedule(): Promise<PublishResult> {
    return Promise.resolve({});
  }
  cancel(): Promise<void> {
    return Promise.resolve();
  }
  countFor(id: string): number {
    return this.calls.filter((call) => call.id === id).length;
  }
}

/** Simulates the API dying after n8n accepted the event and before it was recorded. */
class CrashingDispatcher extends OutboxDispatcherService {
  crashAfterPublish = false;

  protected override acknowledge(
    event: ClaimedEvent,
    published: PublishResult,
  ): Promise<DispatchOutcome> {
    if (this.crashAfterPublish) {
      this.crashAfterPublish = false;
      return Promise.reject(new Error("simulated crash after publish"));
    }
    return super.acknowledge(event, published);
  }
}

describe("outbox dispatcher (private PostgreSQL database)", () => {
  const admin = createPrismaClient(baseUrl);
  const saved: Partial<Record<(typeof environmentKeys)[number], string | undefined>> = {};
  let database: ReturnType<typeof createPrismaClient>;
  let gateway: FakeGateway;
  let dispatcher: CrashingDispatcher;
  let stageRuns: StageRunService;
  let databaseService: DatabaseService;
  let userId = "";
  let sectorId = "";

  async function seedCampaign(status: "STARTING" | "RUNNING" | "PAUSED" | "STOPPED" | "FAILED" = "STARTING") {
    return database.campaign.create({
      data: {
        name: `PH1-01b ${randomUUID()}`,
        sectorId,
        createdByUserId: userId,
        status,
        researchDepth: "STANDARD",
        targetLeadCount: 10,
        minimumScore: 70,
        dailyEmailLimit: 10,
      },
    });
  }

  async function seedEvent(
    campaignId: string,
    overrides: { eventType?: string; aggregateType?: string; aggregateId?: string } = {},
  ) {
    const event = await database.outboxEvent.create({
      data: {
        eventType: overrides.eventType ?? "CAMPAIGN_STARTED",
        aggregateType: overrides.aggregateType ?? "campaign",
        aggregateId: overrides.aggregateId ?? campaignId,
        idempotencyKey: `campaign-start:${overrides.aggregateId ?? campaignId}`,
        payload: { campaignId, actorUserId: userId },
      },
    });
    if (!overrides.aggregateId) {
      await database.automationRun.create({
        data: { campaignId, outboxEventId: event.id, provider: "n8n" },
      });
    }
    return event;
  }

  const expireLease = (id: string) =>
    database.$executeRawUnsafe(
      `UPDATE outbox_events SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1::uuid`,
      id,
    );
  const makeDue = (id: string) =>
    database.$executeRawUnsafe(
      `UPDATE outbox_events SET available_at = now() - interval '1 second' WHERE id = $1::uuid`,
      id,
    );
  const eventRow = (id: string) => database.outboxEvent.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    for (const key of environmentKeys) saved[key] = process.env[key];
    await admin.$executeRawUnsafe(`CREATE DATABASE "${databaseName}"`);
    process.env.DATABASE_URL = privateUrl.toString();
    process.env.DIRECT_URL = privateUrl.toString();
    process.env.N8N_SERVICE_SECRET = serviceSecret;
    process.env.N8N_BASE_URL = "http://n8n.test";
    process.env.OUTBOX_DISPATCH_ENABLED = "true";
    process.env.OUTBOX_MAX_ATTEMPTS = "3";
    process.env.OUTBOX_RETRY_BASE_MS = "60000";
    process.env.OUTBOX_RETRY_MAX_MS = "600000";
    process.env.OUTBOX_BATCH_SIZE = "20";
    execSync("pnpm --filter @tcpl-marketer/database exec prisma migrate deploy", {
      env: process.env,
      stdio: "ignore",
    });
    database = createPrismaClient(privateUrl.toString());
    databaseService = { client: database } as unknown as DatabaseService;
    const user = await database.user.create({
      data: { email: `ph101b-${randomUUID()}@example.test`, passwordHash: "unused" },
    });
    userId = user.id;
    const sector = await database.sector.create({
      data: { name: "PH1-01b sector", slug: `ph101b-${randomUUID()}` },
    });
    sectorId = sector.id;
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
    process.env.OUTBOX_DISPATCH_ENABLED = "true";
    await database.outboxEvent.deleteMany({});
    await database.stageRun.deleteMany({});
    await database.campaign.deleteMany({});
    gateway = new FakeGateway();
    const reader = new PrismaCampaignStateReader(databaseService);
    stageRuns = new StageRunService(databaseService, reader);
    dispatcher = new CrashingDispatcher(databaseService, gateway, reader, stageRuns);
  });

  describe("configuration and backoff", () => {
    it("is disabled by default and validates its settings", () => {
      expect(readOutboxDispatchConfig({}).enabled).toBe(false);
      expect(() => readOutboxDispatchConfig({ OUTBOX_MAX_ATTEMPTS: "0" })).toThrow(/OUTBOX_MAX_ATTEMPTS/);
      expect(() => readOutboxDispatchConfig({ OUTBOX_DISPATCH_ENABLED: "yes" })).toThrow(/OUTBOX_DISPATCH_ENABLED/);
      expect(() =>
        readOutboxDispatchConfig({ OUTBOX_RETRY_BASE_MS: "5000", OUTBOX_RETRY_MAX_MS: "1000" }),
      ).toThrow(/invalid/);
      // A lease shorter than the publish timeout would allow two live publishers.
      expect(() =>
        readOutboxDispatchConfig({ OUTBOX_LEASE_SECONDS: "60", N8N_REQUEST_TIMEOUT_MS: "120000" }),
      ).toThrow(/invalid/);
    });

    it("backs off exponentially, caps the delay and applies bounded jitter", () => {
      expect(computeRetryDelayMs(1, 1_000, 60_000, () => 0)).toBe(500);
      expect(computeRetryDelayMs(1, 1_000, 60_000, () => 1)).toBe(1_000);
      expect(computeRetryDelayMs(3, 1_000, 60_000, () => 1)).toBe(4_000);
      expect(computeRetryDelayMs(30, 1_000, 60_000, () => 1)).toBe(60_000);
      expect(computeRetryDelayMs(30, 1_000, 60_000, () => 0)).toBe(30_000);
    });
  });

  it("does nothing on a tick while dispatch is disabled", async () => {
    process.env.OUTBOX_DISPATCH_ENABLED = "false";
    const campaign = await seedCampaign();
    const event = await seedEvent(campaign.id);
    const result = await dispatcher.tick();
    expect(result).toMatchObject({ enabled: false, claimed: 0, published: 0 });
    expect(gateway.calls).toHaveLength(0);
    expect((await eventRow(event.id)).status).toBe("PENDING");
  });

  it("publishes each due event once across concurrent dispatchers", async () => {
    const events = [];
    for (let index = 0; index < 8; index += 1) {
      const campaign = await seedCampaign();
      events.push(await seedEvent(campaign.id));
    }
    const reader = new PrismaCampaignStateReader(databaseService);
    const others = [1, 2, 3].map(
      () => new OutboxDispatcherService(databaseService, gateway, reader, stageRuns),
    );
    const results = await Promise.all([dispatcher.tick(), ...others.map((other) => other.tick())]);
    expect(results.reduce((sum, result) => sum + result.published, 0)).toBe(8);
    for (const event of events) {
      expect(gateway.countFor(event.id)).toBe(1);
      expect(await eventRow(event.id)).toMatchObject({ status: "PUBLISHED", attempts: 1, leaseOwner: null });
    }
  });

  it("publishes one event once when the same event is dispatched concurrently", async () => {
    const campaign = await seedCampaign();
    const event = await seedEvent(campaign.id);
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, () => dispatcher.dispatchEvent(event.id, { ignoreBackoff: true })),
    );
    expect(outcomes.filter((outcome) => outcome.kind === "PUBLISHED")).toHaveLength(1);
    expect(gateway.countFor(event.id)).toBe(1);
  });

  it("publishes outside the claim transaction and records the run on success", async () => {
    const campaign = await seedCampaign();
    const event = await seedEvent(campaign.id);
    let visibleDuringPublish: unknown;
    gateway.handler = async () => {
      // Another connection already sees the committed claim while the call is in flight.
      visibleDuringPublish = (await eventRow(event.id)).status;
      return { externalRunId: "n8n-77" };
    };
    expect((await dispatcher.dispatchEvent(event.id)).kind).toBe("PUBLISHED");
    expect(visibleDuringPublish).toBe("PROCESSING");
    expect(await database.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).toMatchObject({ status: "RUNNING" });
    const run = await database.automationRun.findUniqueOrThrow({ where: { outboxEventId: event.id } });
    // Accepted by n8n is RUNNING, not completed.
    expect(run).toMatchObject({ status: "RUNNING", attempts: 1, externalRunId: "n8n-77" });
    expect(await database.auditLog.count({ where: { action: "campaign.started", resourceId: campaign.id } })).toBe(1);
  });

  it("retries with backoff and does not publish again before the event is due", async () => {
    const campaign = await seedCampaign();
    const event = await seedEvent(campaign.id);
    gateway.handler = () => Promise.reject(new Error("n8n unavailable"));
    const before = Date.now();
    expect((await dispatcher.tick()).retried).toBe(1);
    const row = await eventRow(event.id);
    expect(row).toMatchObject({ status: "PENDING", attempts: 1, lastError: "n8n unavailable", leaseOwner: null });
    const delay = row.availableAt.getTime() - before;
    expect(delay).toBeGreaterThan(25_000);
    expect(delay).toBeLessThan(65_000);
    expect((await dispatcher.tick()).claimed).toBe(0);
    expect(gateway.countFor(event.id)).toBe(1);
    expect((await database.automationRun.findUniqueOrThrow({ where: { outboxEventId: event.id } })).status).toBe("FAILED");

    gateway.handler = () => Promise.resolve({ externalRunId: "recovered" });
    await makeDue(event.id);
    expect((await dispatcher.tick()).published).toBe(1);
    expect(await eventRow(event.id)).toMatchObject({ status: "PUBLISHED", attempts: 2, lastError: null });
  });

  it("dead-letters after the maximum attempts, fails the campaign and stops retrying", async () => {
    const campaign = await seedCampaign();
    const event = await seedEvent(campaign.id);
    gateway.handler = () => Promise.reject(new Error("n8n returned HTTP 500"));
    await dispatcher.tick();
    await makeDue(event.id);
    await dispatcher.tick();
    await makeDue(event.id);
    expect((await dispatcher.tick()).deadLettered).toBe(1);
    const row = await eventRow(event.id);
    expect(row.status).toBe("DEAD_LETTER");
    expect(row.attempts).toBe(3);
    expect(row.lastError).toMatch(/Gave up after 3 attempts: n8n returned HTTP 500/);
    expect(row.deadLetteredAt).not.toBeNull();
    expect((await database.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("FAILED");
    expect(await database.auditLog.count({ where: { action: "orchestration.event_dead_lettered", resourceId: event.id } })).toBe(1);
    expect((await dispatcher.tick()).claimed).toBe(0);
    expect(gateway.countFor(event.id)).toBe(3);
    const listed = (await dispatcher.listDeadLetters(10)) as Array<Record<string, unknown>>;
    expect(listed.map((item) => item.id)).toContain(event.id);
    expect(listed[0]).not.toHaveProperty("payload");
  });

  it("dead-letters an unroutable event immediately", async () => {
    const campaign = await seedCampaign();
    const event = await seedEvent(campaign.id);
    gateway.handler = () => Promise.reject(new UnroutableOrchestrationEventError("CAMPAIGN_STARTED"));
    expect((await dispatcher.tick()).deadLettered).toBe(1);
    const row = await eventRow(event.id);
    expect(row).toMatchObject({ status: "DEAD_LETTER", attempts: 1 });
    expect(row.lastError).toMatch(/No orchestration route/);
  });

  it("routes by event type, sends the idempotency key and fails closed on unknown types", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ executionId: "exec-1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const adapter = new N8nOrchestrationAdapter();
      const base = { aggregateType: "campaign", aggregateId: randomUUID(), payload: {}, createdAt: new Date().toISOString() };
      const id = randomUUID();
      await expect(adapter.publish({ ...base, id, eventType: "CAMPAIGN_STARTED" })).resolves.toEqual({ externalRunId: "exec-1" });
      expect(fetchMock.mock.calls[0]?.[0]).toBe("http://n8n.test/webhook/campaign-start");
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ "x-idempotency-key": id });
      fetchMock.mockClear();
      await expect(adapter.publish({ ...base, id: randomUUID(), eventType: "CRAWL_COMPLETED" })).rejects.toBeInstanceOf(UnroutableOrchestrationEventError);
      await expect(adapter.publish({ ...base, id: randomUUID(), eventType: "SOMETHING_ELSE" })).rejects.toBeInstanceOf(UnroutableOrchestrationEventError);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("survives a crash after publish: replay creates no duplicate work or provider spend", async () => {
    const campaign = await seedCampaign();
    const event = await seedEvent(campaign.id);
    const prepareDiscovery = vi.fn().mockResolvedValue({ campaignId: campaign.id, persistence: { candidateIds: ["c1"] } });
    const discovery = new DiscoveryStageService(
      databaseService,
      { prepareDiscovery } as unknown as SearchService,
      stageRuns,
    );
    const responses: unknown[] = [];
    gateway.handler = async (published) => {
      responses.push(await discovery.run(published.aggregateId));
      return { externalRunId: `exec-${responses.length}` };
    };

    dispatcher.crashAfterPublish = true;
    const crashed = await dispatcher.tick();
    expect(crashed.errors).toBe(1);
    expect(await eventRow(event.id)).toMatchObject({ status: "PROCESSING", attempts: 1 });
    expect((await database.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("STARTING");

    // While the lease is live nobody else may publish it.
    expect((await dispatcher.tick()).claimed).toBe(0);
    expect(gateway.countFor(event.id)).toBe(1);

    await expireLease(event.id);
    const recovered = await dispatcher.tick();
    expect(recovered).toMatchObject({ reclaimedEvents: 1, claimed: 1, published: 1 });
    expect(gateway.countFor(event.id)).toBe(2);
    expect(await eventRow(event.id)).toMatchObject({ status: "PUBLISHED", attempts: 2 });
    expect((await database.campaign.findUniqueOrThrow({ where: { id: campaign.id } })).status).toBe("RUNNING");

    expect(prepareDiscovery).toHaveBeenCalledTimes(1);
    expect(await database.stageRun.count({ where: { campaignId: campaign.id } })).toBe(1);
    expect(responses[1]).toEqual(responses[0]);
    expect(await database.stageRun.findFirstOrThrow({ where: { campaignId: campaign.id } })).toMatchObject({
      stage: "DISCOVERY",
      status: "SUCCEEDED",
      attempt: 1,
    });
    expect(await database.auditLog.count({ where: { action: "campaign.started", resourceId: campaign.id } })).toBe(1);
  });

  it("dead-letters an expired event that has no attempts left", async () => {
    const campaign = await seedCampaign();
    const event = await seedEvent(campaign.id);
    await database.outboxEvent.update({ where: { id: event.id }, data: { attempts: 2 } });
    dispatcher.crashAfterPublish = true;
    await dispatcher.tick();
    await expireLease(event.id);
    await dispatcher.tick();
    const row = await eventRow(event.id);
    expect(row.status).toBe("DEAD_LETTER");
    expect(row.lastError).toMatch(/lease expired/);
    expect(gateway.countFor(event.id)).toBe(1);
  });

  it("recovers an expired lease on a direct dispatch even with the tick disabled", async () => {
    process.env.OUTBOX_DISPATCH_ENABLED = "false";
    const campaign = await seedCampaign();
    const event = await seedEvent(campaign.id);
    dispatcher.crashAfterPublish = true;
    await expect(dispatcher.dispatchEvent(event.id)).rejects.toThrow(/simulated crash/);
    expect((await dispatcher.dispatchEvent(event.id)).kind).toBe("NOT_CLAIMED");
    await expireLease(event.id);
    expect((await dispatcher.dispatchEvent(event.id)).kind).toBe("PUBLISHED");
    expect(gateway.countFor(event.id)).toBe(2);
  });

  it("does not overwrite state when the lease was lost during publish", async () => {
    const campaign = await seedCampaign();
    const event = await seedEvent(campaign.id);
    gateway.handler = async () => {
      await database.outboxEvent.update({
        where: { id: event.id },
        data: { leaseOwner: "another-dispatcher" },
      });
      return { externalRunId: "stale" };
    };
    expect((await dispatcher.dispatchEvent(event.id)).kind).toBe("LEASE_LOST");
    expect(await eventRow(event.id)).toMatchObject({ status: "PROCESSING", leaseOwner: "another-dispatcher" });
    expect((await database.automationRun.findUniqueOrThrow({ where: { outboxEventId: event.id } })).externalRunId).toBeNull();
  });

  it("never publishes for a stopped or missing campaign and holds a paused one", async () => {
    const stopped = await seedCampaign("STOPPED");
    const stoppedEvent = await seedEvent(stopped.id);
    const paused = await seedCampaign("PAUSED");
    const pausedEvent = await seedEvent(paused.id);
    const missingId = randomUUID();
    const owner = await seedCampaign("RUNNING");
    const missingEvent = await seedEvent(owner.id, { aggregateId: missingId });

    const result = await dispatcher.tick();
    expect(result).toMatchObject({ claimed: 3, deadLettered: 2, held: 1, published: 0 });
    expect(gateway.calls).toHaveLength(0);
    expect((await eventRow(stoppedEvent.id)).status).toBe("DEAD_LETTER");
    expect((await database.campaign.findUniqueOrThrow({ where: { id: stopped.id } })).status).toBe("STOPPED");
    expect((await eventRow(missingEvent.id)).lastError).toMatch(/no longer exists/);

    const held = await eventRow(pausedEvent.id);
    expect(held).toMatchObject({ status: "PENDING", attempts: 0, leaseOwner: null });
    expect(held.availableAt.getTime()).toBeGreaterThan(Date.now());

    await database.campaign.update({ where: { id: paused.id }, data: { status: "RUNNING" } });
    await makeDue(pausedEvent.id);
    expect((await dispatcher.tick()).published).toBe(1);
    expect(await eventRow(pausedEvent.id)).toMatchObject({ status: "PUBLISHED", attempts: 1 });
  });

  describe("discovery stage consumer", () => {
    function discoveryWith(prepareDiscovery: ReturnType<typeof vi.fn>) {
      return new DiscoveryStageService(
        databaseService,
        { prepareDiscovery } as unknown as SearchService,
        stageRuns,
      );
    }

    it("runs once under concurrency and reports the others as in progress", async () => {
      const campaign = await seedCampaign("RUNNING");
      await seedEvent(campaign.id);
      let finish: (value: unknown) => void = () => undefined;
      const prepareDiscovery = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
      const discovery = discoveryWith(prepareDiscovery);
      const first = discovery.run(campaign.id);
      await vi.waitFor(() => expect(prepareDiscovery).toHaveBeenCalledTimes(1));
      const second = await discovery.run(campaign.id);
      expect(second).toMatchObject({ status: "IN_PROGRESS", campaignId: campaign.id });
      finish({ persistence: { candidateIds: ["a"] } });
      await expect(first).resolves.toEqual({ persistence: { candidateIds: ["a"] } });
      await expect(discovery.run(campaign.id)).resolves.toEqual({ persistence: { candidateIds: ["a"] } });
      expect(prepareDiscovery).toHaveBeenCalledTimes(1);
    });

    it("releases the run on failure without storing provider error text, then retries", async () => {
      const campaign = await seedCampaign("RUNNING");
      await seedEvent(campaign.id);
      const prepareDiscovery = vi
        .fn()
        .mockRejectedValueOnce(new Error("provider said: Incorrect API key sk-secret"))
        .mockResolvedValueOnce({ persistence: { candidateIds: ["b"] } });
      const discovery = discoveryWith(prepareDiscovery);
      await expect(discovery.run(campaign.id)).rejects.toThrow(/provider said/);
      const released = await database.stageRun.findFirstOrThrow({ where: { campaignId: campaign.id } });
      expect(released.status).toBe("PENDING");
      expect(released.lastError).toBe("Discovery failed: Error");
      await expect(discovery.run(campaign.id)).resolves.toEqual({ persistence: { candidateIds: ["b"] } });
      expect(await database.stageRun.findFirstOrThrow({ where: { campaignId: campaign.id } })).toMatchObject({ status: "SUCCEEDED", attempt: 2 });
    });

    it("takes over a run whose worker died", async () => {
      const campaign = await seedCampaign("RUNNING");
      await seedEvent(campaign.id);
      const prepareDiscovery = vi.fn().mockResolvedValue({ persistence: { candidateIds: ["c"] } });
      const discovery = discoveryWith(prepareDiscovery);
      const { run } = await stageRuns.ensure({
        campaignId: campaign.id,
        stage: "DISCOVERY",
        entityType: "campaign",
        entityId: campaign.id,
        input: { startEventId: (await database.outboxEvent.findFirstOrThrow({ where: { aggregateId: campaign.id } })).id },
      });
      await stageRuns.claim(run.id, "dead-worker", 60);
      await database.$executeRawUnsafe(`UPDATE stage_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1::uuid`, run.id);
      await expect(discovery.run(campaign.id)).resolves.toEqual({ persistence: { candidateIds: ["c"] } });
      expect(await stageRuns.get(run.id)).toMatchObject({ status: "SUCCEEDED", attempt: 2 });
    });

    it("refuses a stopped campaign, an unknown campaign and a campaign with no start event", async () => {
      const prepareDiscovery = vi.fn();
      const discovery = discoveryWith(prepareDiscovery);
      const stopped = await seedCampaign("STOPPED");
      await seedEvent(stopped.id);
      await expect(discovery.run(stopped.id)).rejects.toThrow(/not ready/);
      await expect(discovery.run(randomUUID())).rejects.toThrow(/not found/);
      const noEvent = await seedCampaign("RUNNING");
      await expect(discovery.run(noEvent.id)).rejects.toThrow(/no recorded start event/);
      expect(prepareDiscovery).not.toHaveBeenCalled();
    });
  });

  describe("HTTP endpoints", () => {
    let app: INestApplication;
    let manager: ReturnType<typeof request.agent>;
    let member: ReturnType<typeof request.agent>;

    const signed = (method: "GET" | "POST", path: string, secret = serviceSecret) => {
      const timestamp = Date.now().toString();
      const signature = createHmac("sha256", secret).update(`${timestamp}\n${method}\n${path}`).digest("hex");
      const call = method === "POST" ? request(app.getHttpServer()).post(path) : request(app.getHttpServer()).get(path);
      return call.set("x-service-timestamp", timestamp).set("x-service-signature", signature);
    };

    beforeAll(async () => {
      const passwordHash = await new PasswordHasher().hash(password);
      const managerRole = await database.role.upsert({ where: { name: "MANAGER" }, create: { name: "MANAGER" }, update: {} });
      const bdeRole = await database.role.upsert({ where: { name: "BDE" }, create: { name: "BDE" }, update: {} });
      await database.user.create({ data: { email: managerEmail, passwordHash, roles: { create: { roleId: managerRole.id } } } });
      await database.user.create({ data: { email: memberEmail, passwordHash, roles: { create: { roleId: bdeRole.id } } } });
      app = await createApp();
      await app.init();
      manager = request.agent(app.getHttpServer());
      member = request.agent(app.getHttpServer());
      await manager.post("/auth/login").send({ email: managerEmail, password }).expect(200);
      await member.post("/auth/login").send({ email: memberEmail, password }).expect(200);
    });

    afterAll(async () => {
      await app?.close();
    });

    it("protects the dispatch tick with service authentication", async () => {
      const path = "/internal/orchestration/dispatch";
      await request(app.getHttpServer()).post(path).expect(401);
      await signed("POST", path, "wrong-secret-value").expect(401);
      // A signature is bound to one method and path.
      const timestamp = Date.now().toString();
      const otherPath = createHmac("sha256", serviceSecret).update(`${timestamp}\nPOST\n/internal/other`).digest("hex");
      await request(app.getHttpServer()).post(path).set("x-service-timestamp", timestamp).set("x-service-signature", otherPath).expect(401);
      await manager.post(path).expect(401);
      const response = await signed("POST", path).expect(200);
      expect(response.body).toMatchObject({ enabled: true, claimed: 0 });
    });

    it("limits the operator views to managers and never returns payloads", async () => {
      const campaign = await seedCampaign("STOPPED");
      const event = await seedEvent(campaign.id);
      await request(app.getHttpServer()).post("/internal/orchestration/dispatch").expect(401);
      await signed("POST", "/internal/orchestration/dispatch").expect(200);

      await request(app.getHttpServer()).get("/orchestration/dead-letters").expect(401);
      await member.get("/orchestration/dead-letters").expect(403);
      await member.get("/orchestration/in-flight").expect(403);
      const letters = await manager.get("/orchestration/dead-letters?limit=5").expect(200);
      expect(letters.body.map((item: { id: string }) => item.id)).toContain(event.id);
      expect(letters.body[0]).not.toHaveProperty("payload");
      await manager.get("/orchestration/dead-letters?limit=0").expect(400);
      await manager.get("/orchestration/in-flight?limit=abc").expect(400);
      await manager.get("/orchestration/in-flight").expect(200);
    });
  });

  it("keeps the tick workflow orchestration-only and inactive", async () => {
    const workflow = JSON.parse(
      await readFile(new URL("../../../automation/n8n/workflows/outbox-dispatch.json", import.meta.url), "utf8"),
    ) as {
      active: boolean;
      nodes: Array<{ name: string; type: string; parameters: { method?: string; url?: string; value?: string } }>;
      connections: Record<string, { main: Array<Array<{ node: string }>> }>;
    };
    expect(workflow.active).toBe(false);
    expect(workflow.nodes.map((node) => node.type.split(".").pop())).toEqual([
      "scheduleTrigger",
      "set",
      "crypto",
      "httpRequest",
    ]);
    const http = workflow.nodes.find((node) => node.type.endsWith("httpRequest"));
    expect(http?.parameters).toMatchObject({ method: "POST", url: "={{ $env.TCPL_API_URL + $json.dispatchPath }}" });
    expect(JSON.stringify(workflow)).toContain("/internal/orchestration/dispatch");
    expect(workflow.connections["Every Minute"]?.main[0]?.[0]?.node).toBe("Prepare Dispatch Request");
    expect(workflow.connections["Sign Dispatch Request"]?.main[0]?.[0]?.node).toBe("Run Dispatch Tick in NestJS");
  });
});
