import { createHash, createHmac, randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { createPrismaClient } from "@tcpl-marketer/database";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/bootstrap.js";

const database = createPrismaClient();
const serviceSecret = "d015-test-service-secret-with-sufficient-entropy";

describe("opportunity scoring persistence and protected review API", () => {
  let app: INestApplication | undefined;
  let userId = "";
  let sectorId = "";
  let organizationId = "";
  let campaignId = "";
  let candidateId = "";
  let crawlRunId = "";
  let sourceId = "";
  const originalSecret = process.env.N8N_SERVICE_SECRET;

  beforeAll(async () => {
    process.env.N8N_SERVICE_SECRET = serviceSecret;
    const user = await database.user.create({
      data: {
        email: `d015-${randomUUID()}@example.test`,
        passwordHash: "not-used-by-this-integration-test",
      },
    });
    userId = user.id;
    const sector = await database.sector.create({
      data: {
        name: "Aerial survey",
        slug: `d015-${randomUUID()}`,
        capabilities: {
          create: {
            name: "LiDAR processing",
            slug: `d015-capability-${randomUUID()}`,
            businessProblems: ["point cloud"],
            targetProfiles: {
              create: {
                name: "Survey bureau",
                slug: `d015-target-${randomUUID()}`,
                positiveTerms: ["aerial survey", "subcontractor"],
                outsourcingCharacteristics: "seeking subcontractor",
              },
            },
          },
        },
      },
      include: {
        capabilities: { include: { targetProfiles: true } },
      },
    });
    sectorId = sector.id;
    const capability = sector.capabilities[0];
    const target = capability.targetProfiles[0];
    const campaign = await database.campaign.create({
      data: {
        name: "D015 persisted scoring",
        sectorId,
        createdByUserId: userId,
        researchDepth: "STANDARD",
        countries: ["United States"],
        targetLeadCount: 1,
        minimumScore: 70,
        sectorFitWeight: 0,
        capabilityMatchWeight: 0,
        targetClientFitWeight: 0,
        outsourcingWeight: 0,
        buyingIntentWeight: 100,
        businessMomentumWeight: 0,
        decisionMakerWeight: 0,
        contactConfidenceWeight: 0,
        dailyEmailLimit: 1,
        capabilities: { create: { capabilityId: capability.id } },
        targets: { create: { targetClientProfileId: target.id } },
      },
    });
    campaignId = campaign.id;
    const organization = await database.organization.create({
      data: {
        name: "D015 Qualified Survey Company",
        normalizedName: `d015-${randomUUID()}`,
        location: "Test",
        normalizedLocation: "test",
      },
    });
    organizationId = organization.id;
    const candidate = await database.leadCandidate.create({
      data: {
        campaignId,
        organizationId,
        status: "ANALYSING",
        idempotencyKey: `d015:${randomUUID()}`,
        sourceUrl: "https://d015.example/services",
        sourceTitle: "Services",
        summary: "A qualified aerial survey provider.",
        evidenceSnippet: "LiDAR processing and subcontractor demand.",
        searchStrategyType: "RFP_VENDOR",
        searchQuery: "LiDAR subcontractor RFP",
      },
    });
    candidateId = candidate.id;
    const crawlRun = await database.crawlRun.create({
      data: {
        organizationId,
        homepageUrl: "https://d015.example/",
        status: "SUCCEEDED",
        completedAt: new Date(),
      },
    });
    crawlRunId = crawlRun.id;
    const text =
      "The aerial survey bureau provides LiDAR processing and point cloud services and issued an RFP seeking a subcontractor.";
    const attempt = await database.crawlAttempt.create({
      data: {
        crawlRunId,
        requestedUrl: "https://d015.example/opportunity",
        finalUrl: "https://d015.example/opportunity",
        method: "HTTP",
        status: "SUCCEEDED",
        httpStatus: 200,
        textLength: text.length,
        source: {
          create: {
            organizationId,
            crawlRunId,
            url: "https://d015.example/opportunity",
            sourceType: "COMPANY_WEBSITE",
            authority: "FIRST_PARTY",
            contentHash: createHash("sha256").update(text).digest("hex"),
            webDocument: {
              create: { text, fetchMethod: "HTTP", httpStatus: 200 },
            },
          },
        },
      },
      include: { source: true },
    });
    const extraction = await database.claimExtractionRun.create({
      data: {
        organizationId,
        idempotencyKey: createHash("sha256")
          .update(`d015:${randomUUID()}`)
          .digest("hex"),
        documentSetHash: createHash("sha256").update(text).digest("hex"),
        provider: "test",
        model: "test-model",
        promptName: "company-claim-extraction",
        promptVersion: "v1",
        status: "SUCCEEDED",
        completedAt: new Date(),
        claims: {
          create: [
            {
              organizationId,
              claimType: "CAPABILITY",
              statement:
                "The aerial survey bureau provides LiDAR processing and point cloud services.",
              fingerprint: createHash("sha256")
                .update(`capability:${randomUUID()}`)
                .digest("hex"),
              evidence: { create: { sourceId: attempt.source!.id } },
            },
            {
              organizationId,
              claimType: "RFP",
              statement:
                "The aerial survey bureau issued an RFP seeking a subcontractor for LiDAR processing.",
              fingerprint: createHash("sha256")
                .update(`rfp:${randomUUID()}`)
                .digest("hex"),
              evidence: { create: { sourceId: attempt.source!.id } },
            },
          ],
        },
      },
    });
    sourceId = attempt.source!.id;
    expect(extraction.status).toBe("SUCCEEDED");

    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    try {
      if (campaignId) await database.campaign.delete({ where: { id: campaignId } });
      if (organizationId) {
        await database.claimExtractionRun.deleteMany({ where: { organizationId } });
        await database.crawlRun.deleteMany({ where: { organizationId } });
        await database.organization.delete({ where: { id: organizationId } });
      }
      if (sectorId) await database.sector.delete({ where: { id: sectorId } });
      if (userId) await database.user.delete({ where: { id: userId } });
      if (app) await app.close();
    } finally {
      if (originalSecret === undefined) delete process.env.N8N_SERVICE_SECRET;
      else process.env.N8N_SERVICE_SECRET = originalSecret;
      await database.$disconnect();
    }
  });

  it("persists one explainable qualified score and returns it for review", async () => {
    await request(app!.getHttpServer())
      .post(`/internal/lead-candidates/${candidateId}/score`)
      .expect(401);

    const first = await signedRequest("POST").expect(201);
    expect(first.body).toMatchObject({
      leadCandidateId: candidateId,
      candidateStatus: "BDE_REVIEW",
      cached: false,
      weights: {
        sectorFit: 0,
        capabilityMatch: 0,
        targetClientFit: 0,
        outsourcingProbability: 0,
        buyingIntent: 100,
        businessMomentum: 0,
        decisionMakerQuality: 0,
        contactConfidence: 0,
      },
      result: {
        organizationId,
        score: 100,
        grade: "A_PLUS_URGENT",
        qualified: true,
        recommendedAction: "URGENT_BDE_REVIEW",
        minimumScore: 70,
      },
    });
    expect(first.body.result.components).toHaveLength(8);
    expect(first.body.result.reasons.length).toBeGreaterThan(0);
    expect(first.body.result.evidenceIds).toHaveLength(1);

    const repeated = await signedRequest("POST").expect(201);
    expect(repeated.body).toMatchObject({ id: first.body.id, cached: true });
    expect(
      await database.leadScore.count({ where: { leadCandidateId: candidateId } }),
    ).toBe(1);

    const review = await signedRequest("GET").expect(200);
    expect(review.body).toMatchObject({
      id: first.body.id,
      candidateStatus: "BDE_REVIEW",
      result: { score: 100, grade: "A_PLUS_URGENT", qualified: true },
    });

    await database.campaign.update({
      where: { id: campaignId },
      data: {
        sectorFitWeight: 0,
        capabilityMatchWeight: 100,
        targetClientFitWeight: 0,
        outsourcingWeight: 0,
        buyingIntentWeight: 0,
        businessMomentumWeight: 0,
        decisionMakerWeight: 0,
        contactConfidenceWeight: 0,
      },
    });
    const nextRun = await database.claimExtractionRun.create({
      data: {
        organizationId,
        idempotencyKey: createHash("sha256")
          .update(`d015-rescore:${randomUUID()}`)
          .digest("hex"),
        documentSetHash: createHash("sha256")
          .update(`d015-rescore:${randomUUID()}`)
          .digest("hex"),
        provider: "test",
        model: "test-model",
        promptName: "company-claim-extraction",
        promptVersion: "v1",
        status: "SUCCEEDED",
        completedAt: new Date(Date.now() + 1_000),
        claims: {
          create: {
            organizationId,
            claimType: "CAPABILITY",
            statement:
              "The aerial survey bureau provides LiDAR processing and point cloud services.",
            fingerprint: createHash("sha256")
              .update(`capability-rescore:${randomUUID()}`)
              .digest("hex"),
            evidence: { create: { sourceId } },
          },
        },
      },
    });

    const rescored = await signedRequest("POST").expect(201);
    expect(rescored.body).toMatchObject({
      claimExtractionRunId: nextRun.id,
      candidateStatus: "QUALIFIED",
      cached: false,
      weights: { capabilityMatch: 100, buyingIntent: 0 },
      result: {
        score: 100,
        grade: "A_PLUS_URGENT",
        qualified: true,
        recommendedAction: "STANDARD_REVIEW",
      },
    });
    expect(
      await database.leadScore.count({ where: { leadCandidateId: candidateId } }),
    ).toBe(2);
  });

  function signedRequest(
    method: "GET" | "POST",
    action: "score" | "research" = "score",
  ) {
    const path = `/internal/lead-candidates/${candidateId}/${action}`;
    const timestamp = Date.now().toString();
    const signature = createHmac("sha256", serviceSecret)
      .update(`${timestamp}\n${method}\n${path}`)
      .digest("hex");
    const agent = request(app!.getHttpServer());
    const pending = method === "GET" ? agent.get(path) : agent.post(path);
    return pending
      .set("x-service-timestamp", timestamp)
      .set("x-service-signature", signature);
  }
});
