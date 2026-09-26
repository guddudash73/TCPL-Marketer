import { createHash, createHmac, randomUUID } from "node:crypto";

import { BadGatewayException, type INestApplication } from "@nestjs/common";
import { createPrismaClient } from "@tcpl-marketer/database";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/bootstrap.js";
import { OpenAIClaimExtractionAdapter } from "../src/company-intelligence/openai-claim-extraction.adapter.js";

const database = createPrismaClient();
const serviceSecret = "d014c-test-service-secret-with-sufficient-entropy";

describe("company intelligence persistence and protected API", () => {
  let app: INestApplication | undefined;
  let organizationId = "";
  let sourceId = "";
  let crawlRunId = "";
  let candidateId = "";
  let campaignId = "";
  let sectorId = "";
  let userId = "";
  const originalKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_RESEARCH_MODEL;
  const originalSecret = process.env.N8N_SERVICE_SECRET;

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.OPENAI_RESEARCH_MODEL = "test-research-model";
    process.env.N8N_SERVICE_SECRET = serviceSecret;

    const organization = await database.organization.create({
      data: {
        name: "D014c Intelligence Company",
        normalizedName: `d014c-${randomUUID()}`,
        location: "Test",
        normalizedLocation: "test",
      },
    });
    organizationId = organization.id;
    const sector = await database.sector.create({
      data: { name: `D014c Sector ${randomUUID()}`, slug: `d014c-${randomUUID()}` },
    });
    sectorId = sector.id;
    const user = await database.user.create({
      data: {
        email: `d014c-${randomUUID()}@example.test`,
        passwordHash: "not-used-by-this-integration-test",
      },
    });
    userId = user.id;
    const campaign = await database.campaign.create({
      data: {
        name: "D014c Company Intelligence",
        sectorId,
        createdByUserId: userId,
        researchDepth: "STANDARD",
        countries: ["United States"],
        targetLeadCount: 1,
        minimumScore: 70,
        dailyEmailLimit: 1,
      },
    });
    campaignId = campaign.id;
    const candidate = await database.leadCandidate.create({
      data: {
        campaignId,
        organizationId,
        idempotencyKey: `d014c:${randomUUID()}`,
        sourceUrl: "https://d014c.example/services",
        sourceTitle: "Services",
        summary: "A LiDAR mapping company.",
        evidenceSnippet: "Provides aerial LiDAR mapping.",
        searchStrategyType: "DIRECT_COMPANY",
        searchQuery: "LiDAR mapping company",
      },
    });
    candidateId = candidate.id;
    const crawlRun = await database.crawlRun.create({
      data: {
        organizationId,
        homepageUrl: "https://d014c.example/",
        status: "SUCCEEDED",
        completedAt: new Date(),
      },
    });
    crawlRunId = crawlRun.id;
    const text = "D014c Intelligence Company provides aerial LiDAR mapping.";
    const attempt = await database.crawlAttempt.create({
      data: {
        crawlRunId: crawlRun.id,
        requestedUrl: "https://d014c.example/services",
        finalUrl: "https://d014c.example/services",
        method: "HTTP",
        status: "SUCCEEDED",
        httpStatus: 200,
        title: "Services",
        textLength: text.length,
        source: {
          create: {
            organizationId,
            crawlRunId: crawlRun.id,
            url: "https://d014c.example/services",
            title: "Services",
            publisher: "d014c.example",
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
    sourceId = attempt.source!.id;

    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    try {
      if (organizationId) {
        await database.claimExtractionRun.deleteMany({
          where: { organizationId },
        });
        if (campaignId) {
          await database.campaign.delete({ where: { id: campaignId } });
        }
        await database.crawlRun.deleteMany({ where: { organizationId } });
        await database.organization.delete({ where: { id: organizationId } });
      }
      if (userId) await database.user.delete({ where: { id: userId } });
      if (sectorId) await database.sector.delete({ where: { id: sectorId } });
      if (app) await app.close();
    } finally {
      restoreEnvironment("OPENAI_API_KEY", originalKey);
      restoreEnvironment("OPENAI_RESEARCH_MODEL", originalModel);
      restoreEnvironment("N8N_SERVICE_SECRET", originalSecret);
      vi.restoreAllMocks();
      await database.$disconnect();
    }
  });

  it("persists source-backed claims and returns the cached profile on retry", async () => {
    const adapter = app!.get(OpenAIClaimExtractionAdapter);
    const extract = vi.spyOn(adapter, "extract").mockResolvedValue({
      data: {
        claims: [
          {
            statement:
              "D014c Intelligence Company provides aerial LiDAR mapping.",
            type: "CAPABILITY",
            evidenceIds: [sourceId],
          },
        ],
      },
      model: "test-research-model",
      providerResponseId: "resp-d014c",
      prompt: { name: "company-claim-extraction", version: "v1" },
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
    });

    await request(app!.getHttpServer())
      .post(`/internal/lead-candidates/${candidateId}/research`)
      .expect(401);

    const first = await signedRequest("POST", "research").expect(201);
    expect(first.body.candidate).toEqual({
      id: candidateId,
      organizationId,
      status: "ANALYSING",
    });
    expect(first.body.profile.extraction).toMatchObject({
      provider: "openai",
      model: "test-research-model",
      providerResponseId: "resp-d014c",
      cached: false,
    });
    expect(first.body.profile.claims).toEqual([
      expect.objectContaining({
        type: "CAPABILITY",
        sources: [
          expect.objectContaining({
            id: sourceId,
            url: "https://d014c.example/services",
            authority: "FIRST_PARTY",
          }),
        ],
      }),
    ]);

    const repeated = await signedRequest("POST", "research").expect(201);
    expect(repeated.body.profile.extraction.id).toBe(
      first.body.profile.extraction.id,
    );
    expect(repeated.body.profile.extraction.cached).toBe(true);
    expect(extract).toHaveBeenCalledTimes(1);

    const profile = await signedRequest("GET", "profile").expect(200);
    expect(profile.body.claims).toEqual(first.body.profile.claims);
    expect(
      await database.claimExtractionRun.count({ where: { organizationId } }),
    ).toBe(1);
    expect(await database.claim.count({ where: { organizationId } })).toBe(1);
    expect(await database.claimEvidence.count({ where: { sourceId } })).toBe(1);
  });

  it("records provider failure and safely retries the same document set", async () => {
    vi.restoreAllMocks();
    const text = "The company also provides point-cloud classification.";
    const attempt = await database.crawlAttempt.create({
      data: {
        crawlRunId,
        requestedUrl: "https://d014c.example/point-cloud",
        finalUrl: "https://d014c.example/point-cloud",
        method: "HTTP",
        status: "SUCCEEDED",
        httpStatus: 200,
        title: "Point-cloud services",
        textLength: text.length,
        source: {
          create: {
            organizationId,
            crawlRunId,
            url: "https://d014c.example/point-cloud",
            title: "Point-cloud services",
            publisher: "d014c.example",
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
    const newSourceId = attempt.source!.id;
    const adapter = app!.get(OpenAIClaimExtractionAdapter);
    const extract = vi
      .spyOn(adapter, "extract")
      .mockRejectedValueOnce(
        new BadGatewayException("temporary provider failure"),
      )
      .mockResolvedValueOnce({
        data: {
          claims: [
            {
              statement:
                "D014c Intelligence Company provides point-cloud classification.",
              type: "CAPABILITY",
              evidenceIds: [newSourceId],
            },
          ],
        },
        model: "test-research-model",
        providerResponseId: "resp-d014c-retry",
        prompt: { name: "company-claim-extraction", version: "v1" },
        usage: null,
      });

    await signedRequest("POST", "research").expect(502);
    expect(
      await database.claimExtractionRun.count({
        where: { organizationId, status: "FAILED" },
      }),
    ).toBe(1);

    const retried = await signedRequest("POST", "research").expect(201);
    expect(retried.body.profile.extraction).toMatchObject({
      providerResponseId: "resp-d014c-retry",
      cached: false,
    });
    expect(retried.body.profile.claims[0].sources[0].id).toBe(newSourceId);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(
      await database.claimExtractionRun.count({ where: { organizationId } }),
    ).toBe(2);
  });

  it("prevents a stale worker from overwriting a recovered run", async () => {
    vi.restoreAllMocks();
    const changedText =
      "D014c Intelligence Company provides independently reviewed LiDAR data.";
    await database.$transaction([
      database.source.update({
        where: { id: sourceId },
        data: {
          contentHash: createHash("sha256").update(changedText).digest("hex"),
        },
      }),
      database.webDocument.update({
        where: { sourceId },
        data: { text: changedText },
      }),
    ]);

    let completeStaleWorker:
      | ((value: ReturnType<typeof providerResult>) => void)
      | undefined;
    const adapter = app!.get(OpenAIClaimExtractionAdapter);
    const extract = vi
      .spyOn(adapter, "extract")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeStaleWorker = resolve;
          }),
      )
      .mockResolvedValueOnce(providerResult("resp-d014c-recovered", sourceId));

    const staleRequest = signedRequest("POST", "research");
    const staleResponse = staleRequest.then((response) => response);
    await vi.waitFor(() => expect(extract).toHaveBeenCalledTimes(1));

    const activeRun = await database.claimExtractionRun.findFirstOrThrow({
      where: { organizationId, status: "RUNNING" },
      orderBy: { startedAt: "desc" },
    });
    await database.claimExtractionRun.update({
      where: { id: activeRun.id },
      data: { startedAt: new Date(Date.now() - 16 * 60 * 1_000) },
    });

    const recovered = await signedRequest("POST", "research").expect(201);
    expect(recovered.body.profile.extraction.providerResponseId).toBe(
      "resp-d014c-recovered",
    );

    completeStaleWorker?.(providerResult("resp-d014c-stale", sourceId));
    expect((await staleResponse).status).toBe(409);
    expect(
      await database.claimExtractionRun.findUniqueOrThrow({
        where: { id: activeRun.id },
        select: { status: true, providerResponseId: true },
      }),
    ).toEqual({ status: "SUCCEEDED", providerResponseId: "resp-d014c-recovered" });
  });

  function signedRequest(method: "GET" | "POST", action: "profile" | "research") {
    const path =
      action === "research"
        ? `/internal/lead-candidates/${candidateId}/research`
        : `/internal/organizations/${organizationId}/profile`;
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

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function providerResult(providerResponseId: string, evidenceId: string) {
  return {
    data: {
      claims: [
        {
          statement:
            "D014c Intelligence Company provides independently reviewed LiDAR data.",
          type: "CAPABILITY" as const,
          evidenceIds: [evidenceId],
        },
      ],
    },
    model: "test-research-model",
    providerResponseId,
    prompt: { name: "company-claim-extraction", version: "v1" },
    usage: null,
  };
}
