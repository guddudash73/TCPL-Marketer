import { createHash, randomUUID } from "node:crypto";

import { BadGatewayException, type INestApplication } from "@nestjs/common";
import { createPrismaClient } from "@tcpl-marketer/database";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/bootstrap.js";
import { OpenAIClaimExtractionAdapter } from "../src/company-intelligence/openai-claim-extraction.adapter.js";
import { OPENAI_CLAIM_CLIENT } from "../src/company-intelligence/openai-claim-extraction.adapter.js";
import { diagnosticCandidateInclude, diagnosticSnapshotHash } from "../src/acceptance/diagnostic-snapshot.js";
import { serviceHeaders } from "./support/service-auth.js";
import type OpenAI from "openai";

const database = createPrismaClient();
const serviceSecret = "d014c-test-service-secret-with-sufficient-entropy";

describe("company intelligence persistence and protected API", () => {
  let app: INestApplication | undefined;
  let organizationId = "";
  let sourceId = "";
  let crawlRunId = "";
  let candidateId = "";
  let noLinkedInOrganizationId = "";
  let noLinkedInCandidateId = "";
  let noDocumentOrganizationId = "";
  let noDocumentCandidateId = "";
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
    const text =
      "D014c Intelligence Company employs 50 to 100 employees and provides aerial LiDAR mapping.";
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

    const noLinkedInOrganization = await database.organization.create({
      data: {
        name: "D014c No LinkedIn Company",
        normalizedName: `d014c-no-linkedin-${randomUUID()}`,
        location: "Test",
        normalizedLocation: "test",
      },
    });
    noLinkedInOrganizationId = noLinkedInOrganization.id;
    const noLinkedInCandidate = await database.leadCandidate.create({
      data: {
        campaignId,
        organizationId: noLinkedInOrganizationId,
        idempotencyKey: `d014c-no-linkedin:${randomUUID()}`,
        sourceUrl: "https://no-linkedin.example/about",
        sourceTitle: "About",
        summary: "Company with no published LinkedIn page.",
        evidenceSnippet: "No LinkedIn page is published.",
        searchStrategyType: "DIRECT_COMPANY",
        searchQuery: "company with no LinkedIn page",
      },
    });
    noLinkedInCandidateId = noLinkedInCandidate.id;
    const noLinkedInCrawlRun = await database.crawlRun.create({
      data: {
        organizationId: noLinkedInOrganizationId,
        homepageUrl: "https://no-linkedin.example/",
        status: "SUCCEEDED",
        completedAt: new Date(),
      },
    });
    const noLinkedInText =
      "This company has no published LinkedIn page and no employee count is published.";
    await database.crawlAttempt.create({
      data: {
        crawlRunId: noLinkedInCrawlRun.id,
        requestedUrl: "https://no-linkedin.example/about",
        finalUrl: "https://no-linkedin.example/about",
        method: "HTTP",
        status: "SUCCEEDED",
        httpStatus: 200,
        title: "About",
        textLength: noLinkedInText.length,
        source: {
          create: {
            organizationId: noLinkedInOrganizationId,
            crawlRunId: noLinkedInCrawlRun.id,
            url: "https://no-linkedin.example/about",
            title: "About",
            publisher: "no-linkedin.example",
            sourceType: "COMPANY_WEBSITE",
            authority: "FIRST_PARTY",
            contentHash: createHash("sha256")
              .update(noLinkedInText)
              .digest("hex"),
            webDocument: {
              create: {
                text: noLinkedInText,
                fetchMethod: "HTTP",
                httpStatus: 200,
              },
            },
          },
        },
      },
    });

    const noDocumentOrganization = await database.organization.create({
      data: {
        name: "D014c No Document Company",
        normalizedName: `d014c-no-document-${randomUUID()}`,
        location: "Test",
        normalizedLocation: "test",
      },
    });
    noDocumentOrganizationId = noDocumentOrganization.id;
    const noDocumentCandidate = await database.leadCandidate.create({
      data: {
        campaignId,
        organizationId: noDocumentOrganizationId,
        idempotencyKey: `d014c-no-document-${randomUUID()}`,
        sourceUrl: "https://no-document.example/",
        sourceTitle: "No stored document",
        summary: "Candidate awaiting source documents.",
        evidenceSnippet: "No source document has been captured.",
        searchStrategyType: "DIRECT_COMPANY",
        searchQuery: "company awaiting crawl",
      },
    });
    noDocumentCandidateId = noDocumentCandidate.id;

    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    try {
      const organizationIds = [
        organizationId,
        noLinkedInOrganizationId,
        noDocumentOrganizationId,
      ].filter(Boolean);
      if (organizationIds.length > 0) {
        await database.companyFitObservation.deleteMany({
          where: { organizationId: { in: organizationIds } },
        });
        await database.claimExtractionRun.deleteMany({
          where: { organizationId: { in: organizationIds } },
        });
        if (campaignId) {
          await database.campaign.delete({ where: { id: campaignId } });
        }
        await database.crawlRun.deleteMany({
          where: { organizationId: { in: organizationIds } },
        });
        await database.organization.deleteMany({
          where: { id: { in: organizationIds } },
        });
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
    const legacyRun = await database.claimExtractionRun.create({
      data: {
        organizationId,
        idempotencyKey: createHash("sha256")
          .update(`legacy-v1:${randomUUID()}`)
          .digest("hex"),
        documentSetHash: "0".repeat(64),
        provider: "openai",
        model: "test-research-model",
        promptName: "company-claim-extraction",
        promptVersion: "v1",
        status: "SUCCEEDED",
        completedAt: new Date(Date.now() - 1_000),
        claims: {
          create: {
            organizationId,
            claimType: "COMPANY_FACT",
            statement: "Legacy v1 extraction must not satisfy the v3 contract.",
            fingerprint: createHash("sha256")
              .update(`legacy-v1-claim:${randomUUID()}`)
              .digest("hex"),
            evidence: { create: { sourceId } },
          },
        },
      },
    });
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
        companyFitObservations: [
          {
            factType: "HEADCOUNT",
            minimum: 50,
            maximum: 100,
            sourceId,
            evidenceExcerpt: "employs 50 to 100 employees",
            confidence: 0.9,
            conflictsWithSourceIds: [],
          },
        ],
      },
      model: "test-research-model",
      providerResponseId: "resp-d014c",
      prompt: { name: "company-claim-extraction", version: "v3" },
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
      prompt: { name: "company-claim-extraction", version: "v3" },
      providerResponseId: "resp-d014c",
      cached: false,
    });
    expect(first.body.profile.extraction.id).not.toBe(legacyRun.id);
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
    expect(first.body.profile.companyFit.facts.headcount.state).toBe(
      "VERIFIED",
    );
    expect(first.body.profile.companyFit.facts.geographies.state).toBe(
      "UNKNOWN",
    );
    expect(first.body.profile.companyFit.facts.businessModels.state).toBe(
      "UNKNOWN",
    );

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
    ).toBe(2);
    expect(await database.claim.count({ where: { organizationId } })).toBe(2);
    expect(await database.claimEvidence.count({ where: { sourceId } })).toBe(2);
  });

  it("retains UNKNOWN company-fit facts when research finds only a missing LinkedIn page", async () => {
    vi.restoreAllMocks();
    const adapter = app!.get(OpenAIClaimExtractionAdapter);
    const extract = vi.spyOn(adapter, "extract").mockResolvedValue({
      data: { claims: [], companyFitObservations: [] },
      model: "test-research-model",
      providerResponseId: "resp-no-linkedin",
      prompt: { name: "company-claim-extraction", version: "v3" },
      usage: null,
    });

    const response = await signedRequest(
      "POST",
      "research",
      noLinkedInCandidateId,
    ).expect(201);

    expect(response.body.profile.companyFit.facts.headcount).toMatchObject({
      state: "UNKNOWN",
      observations: [{ state: "UNKNOWN", source: null }],
    });
    expect(response.body.profile.companyFit.facts.geographies.state).toBe(
      "UNKNOWN",
    );
    expect(response.body.profile.companyFit.facts.businessModels.state).toBe(
      "UNKNOWN",
    );
    expect(extract).toHaveBeenCalledTimes(1);
    expect(
      await database.companyFitObservation.count({
        where: {
          organizationId: noLinkedInOrganizationId,
          state: "UNKNOWN",
        },
      }),
    ).toBe(3);
  });

  it("persists explicit UNKNOWN facts and remains retryable when no documents exist", async () => {
    vi.restoreAllMocks();
    const adapter = app!.get(OpenAIClaimExtractionAdapter);
    const extract = vi.spyOn(adapter, "extract");

    await signedRequest("POST", "research", noDocumentCandidateId).expect(422);

    expect(extract).not.toHaveBeenCalled();
    expect(
      await database.companyFitObservation.count({
        where: {
          organizationId: noDocumentOrganizationId,
          state: "UNKNOWN",
        },
      }),
    ).toBe(3);
    expect(
      await database.leadCandidate.findUniqueOrThrow({
        where: { id: noDocumentCandidateId },
        select: { status: true },
      }),
    ).toEqual({ status: "VALIDATING" });

    const profile = await signedCompanyFitGet(noDocumentOrganizationId).expect(200);
    expect(profile.body.facts.headcount.observations).toEqual([
      expect.objectContaining({
        state: "UNKNOWN",
        freshness: {
          state: "UNKNOWN",
          currentness: "UNKNOWN",
          reason: "NO_SOURCE",
          publishedAt: null,
          capturedAt: null,
        },
        source: null,
      }),
    ]);
    expect(profile.body.facts.geographies.state).toBe("UNKNOWN");
    expect(profile.body.facts.businessModels.state).toBe("UNKNOWN");

    await signedRequest("POST", "research", noDocumentCandidateId).expect(422);
    expect(
      await database.companyFitObservation.count({
        where: { organizationId: noDocumentOrganizationId },
      }),
    ).toBe(3);
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
          companyFitObservations: [],
        },
        model: "test-research-model",
        providerResponseId: "resp-d014c-retry",
        prompt: { name: "company-claim-extraction", version: "v3" },
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
    ).toBe(3);
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

  it.each(["timeout", "rate-limit", "refusal", "malformed", "unsupported-evidence"])("rolls back a fresh candidate on %s and retries without duplicate facts", async (failure) => {
    vi.restoreAllMocks();
    // Each case uses a fresh candidate and a fresh document-set hash.
    const text = `D014c No Document Company employs 37 employees. Attempt ${failure}.`;
    await database.leadCandidate.update({ where: { id: noDocumentCandidateId }, data: { status: "VALIDATING" } });
    const crawl = await database.crawlRun.create({ data: { organizationId: noDocumentOrganizationId, homepageUrl: "https://no-document.example/", status: "SUCCEEDED" } });
    const attempt = await database.crawlAttempt.create({ data: {
      crawlRunId: crawl.id, requestedUrl: `https://no-document.example/${failure}`, method: "HTTP", status: "SUCCEEDED",
      source: { create: { organizationId: noDocumentOrganizationId, crawlRunId: crawl.id, url: `https://no-document.example/${failure}`, sourceType: "COMPANY_WEBSITE", authority: "FIRST_PARTY", contentHash: createHash("sha256").update(text).digest("hex"), webDocument: { create: { text, fetchMethod: "HTTP", httpStatus: 200 } } } },
    }, include: { source: true } });
    const source = attempt.source!;
    const success = {
      id: `f002-${failure}`, status: "completed", model: "test-research-model", output: [], output_parsed: {
        claims: [{ statement: "D014c No Document Company employs 37 employees.", type: "COMPANY_FACT", evidenceIds: [source.id] }], companyFitObservations: [{ factType: "HEADCOUNT", minimum: 37, maximum: 37, sourceId: source.id, evidenceExcerpt: "D014c No Document Company employs 37 employees.", confidence: 0.9, conflictsWithSourceIds: [] }],
      },
    };
    const client = app!.get<OpenAI>(OPENAI_CLAIM_CLIENT);
    const parse = vi.spyOn(client.responses, "parse");
    if (failure === "timeout" || failure === "rate-limit") {
      parse.mockRejectedValueOnce(Object.assign(new Error(failure), { status: failure === "rate-limit" ? 429 : 408 }));
    } else if (failure === "refusal") {
      parse.mockResolvedValueOnce({ ...success, output_parsed: null, output: [{ type: "message", content: [{ type: "refusal", refusal: "fixture refusal" }] }] } as never);
    } else if (failure === "malformed") {
      parse.mockResolvedValueOnce({ ...success, output_parsed: { claims: [], companyFitObservations: [{ factType: "HEADCOUNT", minimum: 100, maximum: 10 }] } } as never);
    } else {
      parse.mockResolvedValueOnce({ ...success, output_parsed: { claims: success.output_parsed.claims, companyFitObservations: [{ ...success.output_parsed.companyFitObservations[0], minimum: 38, maximum: 38 }] } } as never);
    }
    parse.mockResolvedValueOnce(success as never);
    const before = await database.companyFitObservation.count({ where: { organizationId: noDocumentOrganizationId } });
    await signedRequest("POST", "research", noDocumentCandidateId).expect(failure === "unsupported-evidence" ? 422 : 502);
    expect(await database.companyFitObservation.count({ where: { organizationId: noDocumentOrganizationId } })).toBe(before);
    expect(await database.leadCandidate.findUniqueOrThrow({ where: { id: noDocumentCandidateId } })).toMatchObject({ status: "VALIDATING" });
    const failed = await database.claimExtractionRun.findFirstOrThrow({ where: { organizationId: noDocumentOrganizationId, status: "FAILED" }, orderBy: { startedAt: "desc" } });
    expect(await database.claim.count({ where: { extractionRunId: failed.id } })).toBe(0);
    const retry = await signedRequest("POST", "research", noDocumentCandidateId).expect(201);
    expect(retry.body.profile.extraction.id).toBe(failed.id);
    expect(retry.body.profile.companyFit.facts.headcount.state).toBe("VERIFIED");
    await signedRequest("POST", "research", noDocumentCandidateId).expect(201);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(await database.companyFitObservation.count({ where: { sourceId: source.id } })).toBe(1);
  });

  it("makes a failed diagnostic research claim explicitly review-owned and forbids blind replay", async () => {
    vi.restoreAllMocks();
    await database.leadCandidate.update({ where: { id: noDocumentCandidateId }, data: { status: "VALIDATING" } });
    // Change the source set so the provider is required instead of using a cache.
    await database.source.updateMany({ where: { organizationId: noDocumentOrganizationId }, data: { contentHash: createHash("sha256").update("diagnostic-failure-fixture").digest("hex") } });
    const candidate = await database.leadCandidate.findUniqueOrThrow({ where: { id: noDocumentCandidateId }, include: diagnosticCandidateInclude });
    const hash = diagnosticSnapshotHash(candidate);
    const claim = await database.acceptanceDiagnosticRun.create({ data: { leadCandidateId: candidate.id, campaignId, focus: "scoring", inputHash: hash, candidateUpdatedAt: candidate.updatedAt } });
    const extract = vi.spyOn(app!.get(OpenAIClaimExtractionAdapter), "extract").mockRejectedValue(new BadGatewayException("fixture timeout"));
    const call = () => signedRequest("POST", "research", candidate.id, { diagnosticRunId: claim.id, inputHash: hash });
    await call().expect(502);
    expect(await database.acceptanceDiagnosticRun.findUniqueOrThrow({ where: { id: claim.id } })).toMatchObject({ status: "NEEDS_REVIEW", outcome: "RECONCILE_REQUIRED" });
    await call().expect(409);
    expect(extract).toHaveBeenCalledTimes(1);
  });

  function signedRequest(
    method: "GET" | "POST",
    action: "profile" | "research",
    requestedCandidateId = candidateId,
    bound: { diagnosticRunId?: string; inputHash?: string } = {},
  ) {
    const path =
      action === "research"
        ? `/internal/lead-candidates/${requestedCandidateId}/research`
        : `/internal/organizations/${organizationId}/profile`;
    const headers = serviceHeaders(method, path, bound);
    const agent = request(app!.getHttpServer());
    const pending = method === "GET" ? agent.get(path) : agent.post(path);
    return pending
      .set(headers);
  }

  function signedCompanyFitGet(requestedOrganizationId: string) {
    const path = `/internal/organizations/${requestedOrganizationId}/company-fit`;
    const headers = serviceHeaders("GET", path);
    return request(app!.getHttpServer())
      .get(path)
      .set(headers);
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
      companyFitObservations: [],
    },
    model: "test-research-model",
    providerResponseId,
    prompt: { name: "company-claim-extraction", version: "v3" },
    usage: null,
  };
}
