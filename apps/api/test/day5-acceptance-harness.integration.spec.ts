import { createHash, createHmac, randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { createPrismaClient } from "@tcpl-marketer/database";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { runDay5Harness } from "../src/acceptance/day5-harness.js";
import { PasswordHasher } from "../src/auth/password-hasher.js";
import { createApp } from "../src/bootstrap.js";
import { OrganizationResolutionService } from "../src/search/organization-resolution.service.js";

const database = createPrismaClient();
const suffix = randomUUID();
let userId = "";
let sectorId = "";
let organizationId = "";
let campaignId = "";
let candidateId = "";
let selectionId = "";
let profileId = "";
let normalCampaignId = "";
let normalCandidateId = "";
let normalOrganizationId = "";
let reconcileOrganizationId = "";
let reconcileExtractionRunId = "";
let capabilityId = "";
let targetId = "";
let deliverableId = "";
let app: INestApplication | undefined;
const password = "F001-Test-Password!2026";
const originalN8nBaseUrl = process.env.N8N_BASE_URL;
const originalServiceSecret = process.env.N8N_SERVICE_SECRET;

describe("F001 caller-to-PostgreSQL provenance and cleanup boundary", () => {
  beforeAll(async () => {
    process.env.N8N_BASE_URL = "http://n8n.test";
    process.env.N8N_SERVICE_SECRET = "f001-local-test-service-secret";
    const managerRole = await database.role.upsert({
      where: { name: "MANAGER" },
      create: { name: "MANAGER", description: "Campaign management" },
      update: {},
    });
    const user = await database.user.create({
      data: {
        email: `f001-${suffix}@example.test`,
        passwordHash: await new PasswordHasher().hash(password),
        roles: { create: { roleId: managerRole.id } },
      },
    });
    userId = user.id;
    const sector = await database.sector.create({
      data: {
        name: "F001 test sector",
        slug: `f001-${suffix}`,
        capabilities: {
          create: {
            name: "Test capability",
            slug: `f001-capability-${suffix}`,
            deliverables: { create: { name: "Test output", slug: `f001-output-${suffix}` } },
            targetProfiles: {
              create: {
                name: "Test target",
                slug: `f001-target-${suffix}`,
              },
            },
          },
        },
      },
      include: {
        capabilities: {
          include: { targetProfiles: true, deliverables: true },
        },
      },
    });
    sectorId = sector.id;
    const capability = sector.capabilities[0]!;
    const target = capability.targetProfiles[0]!;
    capabilityId = capability.id;
    targetId = target.id;
    deliverableId = capability.deliverables[0]!.id;
    const profile = await database.decisionMakerProfile.create({
      data: {
        capabilityId: capability.id,
        title: "Operations director",
        priority: 1,
      },
    });
    profileId = profile.id;
    const organization = await database.organization.create({
      data: {
        name: "F001 test company",
        normalizedName: `f001-${suffix}`,
        location: "Test",
        normalizedLocation: "test",
      },
    });
    organizationId = organization.id;
    const campaign = await database.campaign.create({
      data: {
        name: `F001 integration ${suffix}`,
        provenance: "ACCEPTANCE_FIXTURE",
        sectorId,
        createdByUserId: userId,
        status: "RUNNING",
        automationMode: "MANUAL_REVIEW",
        researchDepth: "STANDARD",
        countries: ["United States"],
        targetLeadCount: 1,
        minimumScore: 70,
        dailyEmailLimit: 1,
        capabilities: { create: { capabilityId: capability.id } },
        targets: { create: { targetClientProfileId: target.id } },
      },
    });
    campaignId = campaign.id;
    const candidate = await database.leadCandidate.create({
      data: {
        campaignId,
        provenance: "ACCEPTANCE_FIXTURE",
        organizationId,
        idempotencyKey: `f001:${suffix}`,
        sourceUrl: "https://example.test/services",
        sourceTitle: "Services",
        summary: "Test-only discovered company.",
        evidenceSnippet: "Test-only evidence.",
        searchStrategyType: "CAPABILITY",
        searchQuery: "Test capability",
      },
    });
    candidateId = candidate.id;
    const selection = await database.decisionMakerSelection.create({
      data: {
        leadCandidateId: candidateId,
        idempotencyKey: createHash("sha256").update(`f001:${suffix}`).digest("hex"),
        status: "REVIEW_REQUIRED",
        warnings: ["Test-only empty selection"],
      },
    });
    selectionId = selection.id;
    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    try {
      if (normalOrganizationId) await database.crawlRun.deleteMany({ where: { organizationId: normalOrganizationId } });
      if (normalCampaignId) await database.campaign.delete({ where: { id: normalCampaignId } });
      if (campaignId) await database.campaign.delete({ where: { id: campaignId } });
      if (normalOrganizationId) await database.organization.delete({ where: { id: normalOrganizationId } });
      if (reconcileExtractionRunId) await database.claimExtractionRun.delete({ where: { id: reconcileExtractionRunId } });
      if (reconcileOrganizationId) await database.organization.delete({ where: { id: reconcileOrganizationId } });
      if (organizationId) {
        await database.organization.delete({ where: { id: organizationId } });
      }
      if (sectorId) await database.sector.delete({ where: { id: sectorId } });
      if (userId) {
        await database.auditLog.deleteMany({ where: { actorUserId: userId } });
        await database.user.delete({ where: { id: userId } });
      }
      if (app) await app.close();
    } finally {
      if (originalN8nBaseUrl === undefined) delete process.env.N8N_BASE_URL;
      else process.env.N8N_BASE_URL = originalN8nBaseUrl;
      if (originalServiceSecret === undefined) delete process.env.N8N_SERVICE_SECRET;
      else process.env.N8N_SERVICE_SECRET = originalServiceSecret;
      vi.unstubAllGlobals();
      await database.$disconnect();
    }
  });

  it("reads the selected campaign and leaves even an empty pre-existing selection untouched", async () => {
    const input = {
      F001_CAMPAIGN_ID: campaignId,
      F001_CANDIDATE_ID: candidateId,
    };
    const inspected = await runDay5Harness(database, input, "people");
    const cleanup = await runDay5Harness(
      database,
      { ...input, F001_CLEANUP: "1" },
      "people",
    );

    expect(inspected).toMatchObject({
      mode: "INSPECT",
      acceptanceEligible: false,
      campaign: { id: campaignId, capabilityOnly: false, provenance: "ACCEPTANCE_FIXTURE" },
      candidate: { id: candidateId, fixtureProvenance: true },
      before: { selection: { id: selectionId, status: "REVIEW_REQUIRED" } },
    });
    expect(cleanup).toMatchObject({
      mode: "CLEANUP",
      cleanup: { deletedRecords: 0, runOwnedRecordIds: [] },
    });
    expect(
      await database.decisionMakerSelection.findUnique({ where: { id: selectionId } }),
    ).not.toBeNull();
    expect(
      await database.decisionMakerProfile.findUnique({
        where: { id: profileId },
        select: { isActive: true },
      }),
    ).toEqual({ isActive: true });
  });

  it("selects a normal campaign created and started through the authorized API, with a candidate from the production resolver", async () => {
    const publish = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ executionId: "f001-mocked-start" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", publish);
    const manager = request.agent(app!.getHttpServer());
    await manager.post("/auth/login").send({ email: `f001-${suffix}@example.test`, password }).expect(200);
    const created = await manager.post("/campaigns").send({
      name: `F001 normal API ${suffix}`,
      sectorId,
      capabilityIds: [capabilityId],
      deliverableIds: [deliverableId],
      targetClientProfileIds: [targetId],
      countries: ["United States"],
      researchDepth: "STANDARD",
      targetLeadCount: 1,
      minimumScore: 70,
      automationMode: "MANUAL_REVIEW",
      dailyEmailLimit: 1,
      sequence: [{ stepNumber: 1, delayDays: 0 }],
    }).expect(201);
    normalCampaignId = created.body.id as string;
    expect(created.body.provenance).toBe("APPLICATION");
    await manager.post(`/campaigns/${normalCampaignId}/start`).expect(201);
    expect(publish).toHaveBeenCalledTimes(1);

    const resolved = await app!.get(OrganizationResolutionService).persistDiscovery(
      normalCampaignId,
      { countries: ["United States"], states: [], cities: [] },
      [{
        organizationName: `F001 normal ${suffix}`,
        organizationLocation: "Test, United States",
        websiteUrl: `https://f001-${suffix}.example.test`,
        sourceUrl: `https://f001-${suffix}.example.test/services`,
        sourceTitle: "Test service page",
        summary: "Test only; not business evidence.",
        evidenceSnippet: "Test only; not business evidence.",
        strategyType: "DIRECT_COMPANY",
        query: "Test company",
      }],
    );
    normalCandidateId = resolved.candidateIds[0]!;
    normalOrganizationId = resolved.organizationIds[0]!;
    const beforeCount = await database.leadScore.count({ where: { leadCandidateId: normalCandidateId } });
    const inspected = await runDay5Harness(database, {
      F001_CAMPAIGN_ID: normalCampaignId,
      F001_CANDIDATE_ID: normalCandidateId,
    }, "scoring");
    expect(inspected).toMatchObject({
      mode: "INSPECT",
      businessAcceptance: "UNVERIFIED",
      acceptanceEligible: false,
      campaign: { id: normalCampaignId, provenance: "APPLICATION", capabilityOnly: false },
      candidate: { id: normalCandidateId, provenance: "APPLICATION" },
      cleanup: { deletedRecords: 0 },
    });
    expect(inspected.reasons).toContain("No stored source documents for research; wait for the protected crawl stage");
    expect(await database.leadScore.count({ where: { leadCandidateId: normalCandidateId } })).toBe(beforeCount);
    expect(publish).toHaveBeenCalledTimes(1);

    const crawl = await database.crawlRun.create({
      data: {
        organizationId: normalOrganizationId,
        homepageUrl: `https://f001-${suffix}.example.test`,
        status: "SUCCEEDED",
      },
    });
    const attempt = await database.crawlAttempt.create({
      data: {
        crawlRunId: crawl.id,
        requestedUrl: `https://f001-${suffix}.example.test/services`,
        method: "HTTP",
        status: "SUCCEEDED",
        httpStatus: 200,
      },
    });
    await database.source.create({
      data: {
        organizationId: normalOrganizationId,
        crawlRunId: crawl.id,
        crawlAttemptId: attempt.id,
        url: `https://f001-${suffix}.example.test/services`,
        sourceType: "COMPANY_WEBSITE",
        authority: "PRIMARY",
        contentHash: createHash("sha256").update("test document").digest("hex"),
        webDocument: { create: { text: "Test document only.", fetchMethod: "HTTP", httpStatus: 200 } },
      },
    });
    const ready = await runDay5Harness(database, {
      F001_CAMPAIGN_ID: normalCampaignId,
      F001_CANDIDATE_ID: normalCandidateId,
    }, "scoring");
    expect(ready).toMatchObject({ acceptanceEligible: true });

    const beforeResearchRuns = await database.claimExtractionRun.count({
      where: { organizationId: normalOrganizationId },
    });
    const diagnosticRequest = vi.fn().mockImplementation(async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { diagnosticRunId: string; inputHash: string };
      const path = `/internal/lead-candidates/${normalCandidateId}/research`;
      const timestamp = Date.now().toString();
      const signature = createHmac("sha256", "f001-local-test-service-secret")
        .update(`${timestamp}\nPOST\n${path}`).digest("hex");
      const signed = () => request(app!.getHttpServer()).post(path)
        .set("x-service-timestamp", timestamp)
        .set("x-service-signature", signature);

      expect((await signed()).status).toBe(409);
      expect((await signed().set("x-f001-diagnostic-run-id", body.diagnosticRunId)).status).toBe(409);
      const source = await database.source.findFirstOrThrow({
        where: { organizationId: normalOrganizationId, webDocument: { isNot: null } },
      });
      await database.source.update({
        where: { id: source.id },
        data: { contentHash: createHash("sha256").update("changed after claim").digest("hex") },
      });
      expect((await signed()
        .set("x-f001-diagnostic-run-id", body.diagnosticRunId)
        .set("x-f001-input-hash", body.inputHash)).status).toBe(409);
      expect(await database.claimExtractionRun.count({
        where: { organizationId: normalOrganizationId },
      })).toBe(beforeResearchRuns);
      return new Response(null, { status: 429 });
    });
    const diagnosticInput = {
      F001_CAMPAIGN_ID: normalCampaignId,
      F001_CANDIDATE_ID: normalCandidateId,
      F001_EXECUTE: "1",
      N8N_SERVICE_SECRET: "f001-local-test-service-secret",
    };
    const outcomes = await Promise.allSettled([
      runDay5Harness(database, diagnosticInput, "scoring", diagnosticRequest as unknown as typeof fetch),
      runDay5Harness(database, diagnosticInput, "people", diagnosticRequest as unknown as typeof fetch),
    ]);
    expect(outcomes.every(({ status }) => status === "rejected")).toBe(true);
    expect(diagnosticRequest).toHaveBeenCalledTimes(1);
    const durable = await database.acceptanceDiagnosticRun.findUniqueOrThrow({
      where: { leadCandidateId: normalCandidateId },
    });
    expect(durable).toMatchObject({ status: "NEEDS_REVIEW", outcome: "RECONCILE_REQUIRED" });
    expect(await database.leadScore.count({ where: { leadCandidateId: normalCandidateId } })).toBe(beforeCount);

    const reconciled = await runDay5Harness(database, {
      F001_CAMPAIGN_ID: normalCampaignId,
      F001_CANDIDATE_ID: normalCandidateId,
      F001_RECONCILE: "1",
    }, "scoring", diagnosticRequest as unknown as typeof fetch);
    expect(reconciled).toMatchObject({
      mode: "RECONCILE",
      acceptanceEligible: false,
      diagnosticRun: { id: durable.id, status: "NEEDS_REVIEW" },
    });
    expect(diagnosticRequest).toHaveBeenCalledTimes(1);

    await database.leadCandidate.update({
      where: { id: normalCandidateId },
      data: { status: "RESEARCHING" },
    });
    const stuck = await runDay5Harness(database, {
      F001_CAMPAIGN_ID: normalCampaignId,
      F001_CANDIDATE_ID: normalCandidateId,
    }, "scoring");
    expect(stuck).toMatchObject({
      mode: "INSPECT",
      acceptanceEligible: false,
      candidate: { id: normalCandidateId, status: "RESEARCHING" },
    });
    await expect(runDay5Harness(database, {
      F001_CAMPAIGN_ID: normalCampaignId,
      F001_CANDIDATE_ID: normalCandidateId,
      F001_EXECUTE: "1",
    }, "scoring", publish as unknown as typeof fetch)).rejects.toThrow("Candidate is RESEARCHING");
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("reconciles a post-claim PostgreSQL result after a lost webhook acknowledgement without redispatch", async () => {
    const organization = await database.organization.create({
      data: {
        name: "F001 reconciliation test company",
        normalizedName: `f001-reconcile-${suffix}`,
        location: "Test",
        normalizedLocation: "test",
      },
    });
    reconcileOrganizationId = organization.id;
    const candidate = await database.leadCandidate.create({
      data: {
        campaignId: normalCampaignId,
        organizationId: reconcileOrganizationId,
        provenance: "APPLICATION",
        idempotencyKey: `f001-reconcile:${suffix}`,
        sourceUrl: `https://f001-${suffix}.example.test/services`,
        sourceTitle: "Services",
        summary: "Test-only candidate",
        evidenceSnippet: "Test-only evidence",
        searchStrategyType: "DIRECT_COMPANY",
        searchQuery: "Test only",
      },
    });
    const claim = await database.acceptanceDiagnosticRun.create({
      data: {
        leadCandidateId: candidate.id,
        campaignId: normalCampaignId,
        focus: "scoring",
        inputHash: "a".repeat(64),
        candidateUpdatedAt: candidate.updatedAt,
      },
    });
    const extraction = await database.claimExtractionRun.create({
      data: {
        organizationId: reconcileOrganizationId,
        idempotencyKey: createHash("sha256").update(`f001-extraction:${suffix}`).digest("hex"),
        documentSetHash: createHash("sha256").update(`f001-documents:${suffix}`).digest("hex"),
        provider: "test",
        model: "test-model",
        promptName: "company-claim-extraction",
        promptVersion: "v1",
        status: "SUCCEEDED",
        completedAt: new Date(),
      },
    });
    reconcileExtractionRunId = extraction.id;
    const score = await database.leadScore.create({
      data: {
        leadCandidateId: candidate.id,
        claimExtractionRunId: extraction.id,
        idempotencyKey: createHash("sha256").update(`f001-score:${suffix}`).digest("hex"),
        score: 25, needScore: 20, intentScore: 10, grade: "REJECT", qualified: false,
        recommendedAction: "REJECT",
        minimumScore: 70,
        weights: { capabilityMatch: 20 }, components: [], reasons: ["Test-only rejection"],
        evidenceIds: [], highIntentOverride: { applied: false },
      },
    });
    const terminal = await database.leadCandidate.update({
      where: { id: candidate.id }, data: { status: "REJECTED" },
    });
    await database.acceptanceDiagnosticRun.update({
      where: { id: claim.id },
      data: { status: "NEEDS_REVIEW", outcome: "RECONCILE_REQUIRED", candidateUpdatedAt: terminal.updatedAt },
    });
    const request = vi.fn();
    const result = await runDay5Harness(database, {
      F001_CAMPAIGN_ID: normalCampaignId,
      F001_CANDIDATE_ID: candidate.id,
      F001_RECONCILE: "1",
    }, "scoring", request as unknown as typeof fetch);
    expect(result).toMatchObject({
      mode: "RECONCILE", businessAcceptance: "UNVERIFIED",
      diagnosticRun: { id: claim.id, status: "VERIFIED" },
    });
    expect(request).not.toHaveBeenCalled();
    expect(await database.acceptanceDiagnosticRun.findUniqueOrThrow({ where: { id: claim.id } }))
      .toMatchObject({
        status: "VERIFIED", scoreId: score.id,
        outcome: "RECONCILED_PERSISTED_RESULT_NO_WEBHOOK_ACK",
      });
  });
});
