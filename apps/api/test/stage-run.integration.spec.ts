import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@tcpl-marketer/database";
import {
  CAMPAIGN_LIFECYCLE_OWNER,
  OPERATOR_RETRY_OWNER,
  STAGE_DEFINITIONS,
  StageTransitionError,
} from "@tcpl-marketer/orchestration-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DatabaseService } from "../src/database/database.service.js";
import { PrismaCampaignStateReader } from "../src/orchestration/prisma-campaign-state-reader.js";
import { StageRunService } from "../src/orchestration/stage-run.service.js";

const database = createPrismaClient();
const databaseService = { client: database } as unknown as DatabaseService;
const service = new StageRunService(
  databaseService,
  new PrismaCampaignStateReader(databaseService),
);

describe("stage run persistence, leases and constraints (PostgreSQL)", () => {
  let userId = "";
  let sectorId = "";
  let campaignId = "";
  const outboxIds: string[] = [];
  const crawlOwner = STAGE_DEFINITIONS.CRAWL.domainOwner;

  async function freshRun(input: unknown = { version: randomUUID() }) {
    const { run } = await service.ensure({
      campaignId,
      stage: "CRAWL",
      entityType: "lead_candidate",
      entityId: randomUUID(),
      input,
    });
    return run;
  }

  beforeAll(async () => {
    const user = await database.user.create({
      data: {
        email: `ph01a-${randomUUID()}@example.test`,
        passwordHash: "not-used-by-this-integration-test",
      },
    });
    userId = user.id;
    const sector = await database.sector.create({
      data: { name: "PH1-01a test sector", slug: `ph01a-${randomUUID()}` },
    });
    sectorId = sector.id;
    const campaign = await database.campaign.create({
      data: {
        name: "PH1-01a stage runtime",
        sectorId,
        createdByUserId: userId,
        status: "RUNNING",
        researchDepth: "STANDARD",
        targetLeadCount: 10,
        minimumScore: 70,
        dailyEmailLimit: 10,
      },
    });
    campaignId = campaign.id;
  });

  afterAll(async () => {
    if (outboxIds.length) await database.outboxEvent.deleteMany({ where: { id: { in: outboxIds } } });
    await database.campaign.deleteMany({ where: { id: campaignId } }); // stage runs cascade
    await database.sector.deleteMany({ where: { id: sectorId } });
    await database.user.deleteMany({ where: { id: userId } });
    await database.$disconnect();
  });

  it("creates a run once for the same entity, stage and input, even under concurrency", async () => {
    const entityId = randomUUID();
    const input = { crawlPlan: "v1", urls: ["https://example.test"] };
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        service.ensure({ campaignId, stage: "CRAWL", entityType: "lead_candidate", entityId, input }),
      ),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.run.id)).size).toBe(1);
    expect(results[0].run.status).toBe("PENDING");
    expect(results[0].run.attempt).toBe(0);
    // Same input in a different key order is the same version.
    const again = await service.ensure({
      campaignId, stage: "CRAWL", entityType: "lead_candidate", entityId,
      input: { urls: ["https://example.test"], crawlPlan: "v1" },
    });
    expect(again.created).toBe(false);
    // A changed input is a new run; another stage for the same entity is a new run.
    const changed = await service.ensure({
      campaignId, stage: "CRAWL", entityType: "lead_candidate", entityId, input: { crawlPlan: "v2" },
    });
    const research = await service.ensure({
      campaignId, stage: "RESEARCH", entityType: "lead_candidate", entityId, input,
    });
    expect(changed.created).toBe(true);
    expect(research.created).toBe(true);
    expect(await database.stageRun.count({ where: { entityId } })).toBe(3);
  });

  it("rejects an entity type that does not match the stage", async () => {
    await expect(
      service.ensure({ campaignId, stage: "DISCOVERY", entityType: "lead_candidate", entityId: randomUUID(), input: {} }),
    ).rejects.toThrow(StageTransitionError);
  });

  it("lets exactly one of many concurrent claimers hold the lease", async () => {
    const run = await freshRun();
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) => service.claim(run.id, `worker-${index}`, 60)),
    );
    const winners = results.filter((result) => result.claimed);
    expect(winners).toHaveLength(1);
    expect(results.filter((result) => !result.claimed).every((result) => !result.claimed && result.reason === "NOT_PENDING")).toBe(true);
    const stored = await database.stageRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(stored.status).toBe("RUNNING");
    expect(stored.attempt).toBe(1);
    expect(stored.leaseOwner).toMatch(/^worker-\d+$/);
    expect(stored.leaseExpiresAt!.getTime()).toBeGreaterThan(Date.now());
    expect(stored.startedAt).not.toBeNull();
  });

  it("extends a lease only for the holder", async () => {
    const run = await freshRun();
    const claim = await service.claim(run.id, "holder", 30);
    expect(claim.claimed).toBe(true);
    const before = (await service.get(run.id))!.leaseExpiresAt!.getTime();
    expect(await service.heartbeat(run.id, "holder", 600)).toBe(true);
    expect((await service.get(run.id))!.leaseExpiresAt!.getTime()).toBeGreaterThan(before);
    expect(await service.heartbeat(run.id, "intruder", 600)).toBe(false);
  });

  it("finishes only through the stage's domain owner with a valid lease", async () => {
    const run = await freshRun();
    await service.claim(run.id, "finisher", 60);
    await expect(
      service.finish(run.id, { leaseOwner: "finisher", actor: "SearchService", status: "SUCCEEDED", outcome: "OK" }),
    ).rejects.toThrow(/owned by CrawlStageService/);
    await expect(
      service.finish(run.id, { leaseOwner: "someone-else", actor: crawlOwner, status: "SUCCEEDED", outcome: "OK" }),
    ).rejects.toThrow(/valid lease/);
    await expect(
      service.finish(run.id, { leaseOwner: "finisher", actor: crawlOwner, status: "SUCCEEDED", outcome: " " }),
    ).rejects.toThrow(/outcome/);
    const done = await service.finish(run.id, {
      leaseOwner: "finisher", actor: crawlOwner, status: "SUCCEEDED", outcome: "CRAWLED", reason: "3 pages stored",
    });
    expect(done.status).toBe("SUCCEEDED");
    expect(done.leaseOwner).toBeNull();
    expect(done.completedAt).not.toBeNull();
    expect(done.outcome).toBe("CRAWLED");
    await expect(
      service.finish(run.id, { leaseOwner: "finisher", actor: crawlOwner, status: "SUCCEEDED", outcome: "AGAIN" }),
    ).rejects.toThrow(StageTransitionError);
  });

  it("records failures with the reason and keeps review outcomes terminal", async () => {
    const failing = await freshRun();
    await service.claim(failing.id, "w", 60);
    const failed = await service.finish(failing.id, {
      leaseOwner: "w", actor: crawlOwner, status: "FAILED", outcome: "FETCH_FAILED", reason: "timeout",
    });
    expect(failed.status).toBe("FAILED");
    expect(failed.lastError).toBe("timeout");
    const review = await freshRun();
    await service.claim(review.id, "w", 60);
    const reviewed = await service.finish(review.id, {
      leaseOwner: "w", actor: crawlOwner, status: "REVIEW_REQUIRED", outcome: "NEEDS_REVIEW",
    });
    expect(reviewed.status).toBe("REVIEW_REQUIRED");
    expect(reviewed.lastError).toBeNull();
  });

  it("recovers abandoned work: expired lease is reclaimed, then claimable by another worker", async () => {
    const run = await freshRun();
    await service.claim(run.id, "crashed-worker", 60);
    await database.$executeRawUnsafe(
      `UPDATE stage_runs SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1::uuid`, run.id,
    );
    expect(await service.heartbeat(run.id, "crashed-worker", 60)).toBe(false);
    await expect(
      service.finish(run.id, { leaseOwner: "crashed-worker", actor: crawlOwner, status: "SUCCEEDED", outcome: "LATE" }),
    ).rejects.toThrow(/valid lease/);
    expect((await service.findExpired()).map((row) => row.id)).toContain(run.id);
    const reclaimed = await service.reclaimExpired();
    const mine = reclaimed.find((row) => row.id === run.id);
    expect(mine?.status).toBe("PENDING");
    expect(mine?.leaseOwner).toBeNull();
    expect(mine?.lastError).toMatch(/Lease expired/);
    expect(mine?.attempt).toBe(1);
    const second = await service.claim(run.id, "healthy-worker", 60);
    expect(second.claimed && second.run.attempt).toBe(2);
    // Two reclaimers racing never double-reclaim.
    const other = await freshRun();
    await service.claim(other.id, "w", 60);
    await database.$executeRawUnsafe(
      `UPDATE stage_runs SET lease_expires_at = now() - interval '1 second' WHERE id = $1::uuid`, other.id,
    );
    const racing = await Promise.all([service.reclaimExpired(), service.reclaimExpired(), service.reclaimExpired()]);
    expect(racing.flat().filter((row) => row.id === other.id)).toHaveLength(1);
  });

  it("releases a run back to PENDING only for the lease holder", async () => {
    const run = await freshRun();
    await service.claim(run.id, "holder", 60);
    expect(await service.release(run.id, "intruder", "nope")).toBe(false);
    expect(await service.release(run.id, "holder", "shutting down")).toBe(true);
    const stored = await service.get(run.id);
    expect(stored?.status).toBe("PENDING");
    expect(stored?.lastError).toBe("shutting down");
  });

  it("refuses to claim when the campaign is not dispatchable", async () => {
    const run = await freshRun();
    await database.campaign.update({ where: { id: campaignId }, data: { status: "STOPPED" } });
    try {
      const refused = await service.claim(run.id, "w", 60);
      expect(refused).toEqual({ claimed: false, reason: "CAMPAIGN_NOT_DISPATCHABLE" });
      expect((await service.get(run.id))?.status).toBe("PENDING");
    } finally {
      await database.campaign.update({ where: { id: campaignId }, data: { status: "RUNNING" } });
    }
    expect((await service.claim(run.id, "w", 60)).claimed).toBe(true);
    expect(await service.claim(randomUUID(), "w", 60)).toEqual({ claimed: false, reason: "NOT_FOUND" });
  });

  it("applies lifecycle cancel and operator retry only through their owners", async () => {
    const pending = await freshRun();
    await expect(service.transition(pending.id, "CANCELLED", "RandomService")).rejects.toThrow(/owned by CampaignLifecycleService/);
    const cancelled = await service.transition(pending.id, "CANCELLED", CAMPAIGN_LIFECYCLE_OWNER, "campaign stopped");
    expect(cancelled.status).toBe("CANCELLED");
    expect(cancelled.completedAt).not.toBeNull();
    const reopened = await service.transition(pending.id, "PENDING", OPERATOR_RETRY_OWNER, "operator retry");
    expect(reopened.status).toBe("PENDING");
    expect(reopened.completedAt).toBeNull();
    await expect(service.transition(pending.id, "SUCCEEDED", crawlOwner)).rejects.toThrow(/cannot transition/);
  });

  it("enforces integrity rules in the database", async () => {
    const run = await freshRun();
    const sql = (statement: string, ...args: unknown[]) => database.$executeRawUnsafe(statement, ...args);
    await expect(sql(`UPDATE stage_runs SET status = 'RUNNING' WHERE id = $1::uuid`, run.id)).rejects.toThrow(/stage_runs_lease_check/);
    await expect(sql(`UPDATE stage_runs SET status = 'SUCCEEDED' WHERE id = $1::uuid`, run.id)).rejects.toThrow(/stage_runs_completion_check/);
    await expect(sql(`UPDATE stage_runs SET input_hash = 'not-a-hash' WHERE id = $1::uuid`, run.id)).rejects.toThrow();
    await expect(sql(`UPDATE stage_runs SET attempt = -1 WHERE id = $1::uuid`, run.id)).rejects.toThrow(/stage_runs_attempt_check/);
    await expect(
      sql(`INSERT INTO stage_runs (id, campaign_id, entity_type, entity_id, stage, input_hash, updated_at)
           SELECT gen_random_uuid(), campaign_id, entity_type, entity_id, stage, input_hash, now() FROM stage_runs WHERE id = $1::uuid`, run.id),
    ).rejects.toThrow(/Unique constraint|duplicate key/i);
  });

  it("enforces outbox lease and dead-letter rules", async () => {
    const base = (status: string, extra = "") => `
      INSERT INTO outbox_events (id, event_type, aggregate_type, aggregate_id, idempotency_key, payload, status${extra ? ", " + extra.split("|")[0] : ""})
      VALUES (gen_random_uuid(), 'TEST', 'campaign', gen_random_uuid(), $1, '{}'::jsonb, '${status}'::"OutboxEventStatus"${extra ? ", " + extra.split("|")[1] : ""})`;
    const key = () => `ph01a-${randomUUID()}`;
    await expect(database.$executeRawUnsafe(base("PROCESSING"), key())).rejects.toThrow(/outbox_events_lease_check/);
    await expect(database.$executeRawUnsafe(base("DEAD_LETTER"), key())).rejects.toThrow(/outbox_events_dead_letter_check/);
    await expect(
      database.$executeRawUnsafe(base("PENDING", "lease_owner|'x'"), key()),
    ).rejects.toThrow(/outbox_events_lease_check/);
    const okKey = key();
    await database.$executeRawUnsafe(
      base("PROCESSING", "lease_owner, lease_expires_at|'dispatcher-1', now() + interval '1 minute'"), okKey,
    );
    const deadKey = key();
    await database.$executeRawUnsafe(
      base("DEAD_LETTER", "dead_lettered_at, last_error|now(), 'max attempts reached'"), deadKey,
    );
    const rows = await database.outboxEvent.findMany({ where: { idempotencyKey: { in: [okKey, deadKey] } } });
    outboxIds.push(...rows.map((row) => row.id));
    expect(rows).toHaveLength(2);
  });
});
