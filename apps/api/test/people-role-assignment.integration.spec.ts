import { createHash, randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { createPrismaClient } from "@tcpl-marketer/database";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/bootstrap.js";
import { serviceHeaders } from "./support/service-auth.js";

const database = createPrismaClient();
const serviceSecret = "d016-test-service-secret-with-sufficient-entropy";

let userId = "";
let sectorId = "";
let campaignId = "";
let organizationId = "";
let leadCandidateId = "";
let extractionRunId = "";
let app: INestApplication | undefined;
const originalServiceSecret = process.env.N8N_SERVICE_SECRET;
const originalApolloKey = process.env.APOLLO_API_KEY;
const originalOpenAiKey = process.env.OPENAI_API_KEY;
const originalOpenAiModel = process.env.OPENAI_RESEARCH_MODEL;
const originalFetch = globalThis.fetch;

describe("decision-maker role assignment persistence", () => {
  beforeAll(async () => {
    process.env.N8N_SERVICE_SECRET = serviceSecret;
    process.env.APOLLO_API_KEY = "d016-controlled-test-key";
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_RESEARCH_MODEL;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          people: [
            {
              id: "apollo-d016-avery",
              name: "Avery Adams",
              title: "LiDAR Production Manager",
              seniority: "manager",
              departments: ["operations"],
              linkedin_url: "https://www.linkedin.com/in/d016-avery",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    const user = await database.user.create({
      data: {
        email: `d016-${randomUUID()}@example.test`,
        passwordHash: "not-used-by-this-integration-test",
      },
    });
    userId = user.id;

    const sector = await database.sector.create({
      data: {
        name: "D016 Survey",
        slug: `d016-${randomUUID()}`,
        capabilities: {
          create: {
            name: "LiDAR processing",
            slug: `d016-capability-${randomUUID()}`,
            decisionMakers: {
              create: [
                {
                  title: "LiDAR Production Manager",
                  priority: 1,
                  seniorities: ["manager"],
                  positiveTerms: ["lidar", "production"],
                },
                {
                  title: "Survey Operations Director",
                  priority: 2,
                  seniorities: ["director"],
                  positiveTerms: ["survey", "operations"],
                },
                {
                  title: "COO",
                  priority: 5,
                  seniorities: ["c_suite"],
                },
              ],
            },
          },
        },
      },
      include: { capabilities: true },
    });
    sectorId = sector.id;
    const capabilityId = sector.capabilities[0]!.id;

    const campaign = await database.campaign.create({
      data: {
        name: "D016 people selection",
        sectorId,
        createdByUserId: userId,
        // Provider work is refused for a campaign that is not running (PH1-03b).
        status: "RUNNING",
        researchDepth: "STANDARD",
        countries: ["United States"],
        targetLeadCount: 1,
        minimumScore: 70,
        dailyEmailLimit: 1,
        capabilities: { create: { capabilityId } },
      },
    });
    campaignId = campaign.id;

    const organizationDomain = `d016-${randomUUID()}.example`;
    const organization = await database.organization.create({
      data: {
        name: "D016 Qualified Survey Company",
        normalizedName: `d016-${randomUUID()}`,
        domain: organizationDomain,
        normalizedDomain: organizationDomain,
        location: "Colorado",
        normalizedLocation: "colorado",
        people: {
          create: [
            person("Avery Adams", "LiDAR Production Manager", "manager", 0.96),
            person("Bailey Brooks", "Survey Operations Director", "director", 0.9),
            person("Casey Cole", "COO", "c-suite", 0.84),
            person("Control Candidate", "LiDAR Production Manager", "manager", 1, false),
          ],
        },
      },
    });
    organizationId = organization.id;

    const leadCandidate = await database.leadCandidate.create({
      data: {
        campaignId,
        organizationId,
        status: "QUALIFIED",
        idempotencyKey: `d016:${randomUUID()}`,
        sourceUrl: "https://d016.example/services",
        sourceTitle: "Services",
        summary: "Qualified LiDAR processing company.",
        evidenceSnippet: "LiDAR production and survey operations.",
        searchStrategyType: "CAPABILITY",
        searchQuery: "LiDAR processing",
      },
    });
    leadCandidateId = leadCandidate.id;

    const extraction = await database.claimExtractionRun.create({
      data: {
        organizationId,
        idempotencyKey: digest(`d016-extraction:${randomUUID()}`),
        documentSetHash: digest(`d016-documents:${randomUUID()}`),
        provider: "test",
        model: "test-model",
        promptName: "company-claim-extraction",
        promptVersion: "v1",
        status: "SUCCEEDED",
        completedAt: new Date(),
      },
    });
    extractionRunId = extraction.id;

    await database.leadScore.create({
      data: {
        leadCandidateId,
        claimExtractionRunId: extractionRunId,
        idempotencyKey: digest(`d016-score:${randomUUID()}`),
        score: 85,
        needScore: 80,
        intentScore: 70,
        grade: "A",
        qualified: true,
        recommendedAction: "STANDARD_REVIEW",
        minimumScore: 70,
        weights: { decisionMakerQuality: 5 },
        components: [],
        reasons: ["Qualified fixture"],
        evidenceIds: [],
        highIntentOverride: { applied: false },
      },
    });

    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    try {
      if (campaignId) await database.campaign.delete({ where: { id: campaignId } });
      if (extractionRunId) {
        await database.claimExtractionRun.delete({ where: { id: extractionRunId } });
      }
      if (organizationId) {
        await database.organization.delete({ where: { id: organizationId } });
      }
      if (sectorId) await database.sector.delete({ where: { id: sectorId } });
      if (userId) await database.user.delete({ where: { id: userId } });
      if (app) await app.close();
    } finally {
      restore("N8N_SERVICE_SECRET", originalServiceSecret);
      restore("APOLLO_API_KEY", originalApolloKey);
      restore("OPENAI_API_KEY", originalOpenAiKey);
      restore("OPENAI_RESEARCH_MODEL", originalOpenAiModel);
      globalThis.fetch = originalFetch;
      await database.$disconnect();
    }
  });

  it("exposes an authenticated, idempotent and reviewable selection path", async () => {
    await request(app!.getHttpServer())
      .post(`/internal/lead-candidates/${leadCandidateId}/decision-makers`)
      .expect(401);
    const firstResponse = await signedRequest("POST").expect(201);
    const repeatedResponse = await signedRequest("POST").expect(201);
    const reviewResponse = await signedRequest("GET").expect(200);
    const first = firstResponse.body.selection as SelectionResponse;
    const repeated = repeatedResponse.body.selection as SelectionResponse;
    const review = reviewResponse.body as SelectionResponse;

    expect(first.cached).toBe(false);
    expect(first.status).toBe("COMPLETE");
    expect(first.missingSlots).toEqual([]);
    expect(first.assignments.map(({ slot }) => slot)).toEqual([
      "PRIMARY",
      "SECONDARY",
      "FALLBACK",
    ]);
    expect(first.assignments.map(({ person }) => person.fullName)).toEqual([
      "Avery Adams",
      "Bailey Brooks",
      "Casey Cole",
    ]);
    expect(first.assignments.every(({ reasons }) => reasons.length > 0)).toBe(true);
    expect(
      first.assignments.every(
        ({ reviewUrl, person }) =>
          reviewUrl === person.sourceUrl &&
          person.sourceProvider === "d016-fixture",
      ),
    ).toBe(true);
    expect(first.assignments[0]?.components).toMatchObject({
      capabilityRelevance: 35,
      companySizeFit: 0,
    });
    expect(first.warnings).toContain(
      "Excluded 1 candidate without a public review URL",
    );
    expect(firstResponse.body.discovery).toMatchObject({
      attemptedProviders: ["public-web", "apollo"],
      discoveredCandidates: 1,
      persistedCandidates: 1,
    });
    expect(firstResponse.body.discovery.warnings).toHaveLength(1);
    expect(repeated).toMatchObject({ id: first.id, cached: true });
    expect(review).toMatchObject({ id: first.id, cached: true });
    expect(
      await database.decisionMakerSelection.count({ where: { leadCandidateId } }),
    ).toBe(1);
    expect(
      await database.decisionMakerAssignment.count({
        where: { selection: { leadCandidateId } },
      }),
    ).toBe(3);

    await database.leadCandidate.update({
      where: { id: leadCandidateId },
      data: { status: "REJECTED" },
    });
    await signedRequest("POST").expect(422);
    await database.leadCandidate.update({
      where: { id: leadCandidateId },
      data: { status: "QUALIFIED" },
    });

    const surplusRoles = await database.personRole.findMany({
      where: {
        person: {
          organizationId,
          fullName: { in: ["Bailey Brooks", "Casey Cole"] },
        },
      },
      select: { id: true },
    });
    await database.personRole.updateMany({
      where: { id: { in: surplusRoles.map(({ id }) => id) } },
      data: { isCurrent: false },
    });
    const partialResponse = await signedRequest("POST").expect(201);
    const partial = partialResponse.body.selection as SelectionResponse;
    expect(partial.status).toBe("REVIEW_REQUIRED");
    expect(partial.assignments).toHaveLength(1);
    expect(partial.assignments[0]?.person.fullName).toBe("Avery Adams");
    expect(partial.missingSlots).toEqual(["SECONDARY", "FALLBACK"]);
    expect(partial.warnings).toContain(
      "Selection needs manual review: missing SECONDARY, FALLBACK candidate slots",
    );
    expect(
      await database.decisionMakerSelection.count({ where: { leadCandidateId } }),
    ).toBe(2);
  });

  function signedRequest(method: "GET" | "POST") {
    const path = `/internal/lead-candidates/${leadCandidateId}/decision-makers`;
    const headers = serviceHeaders(method, path);
    const agent = request(app!.getHttpServer());
    const pending = method === "GET" ? agent.get(path) : agent.post(path);
    return pending
      .set(headers);
  }
});

function person(
  fullName: string,
  title: string,
  seniority: string,
  confidence: number,
  withSource = true,
) {
  const sourceUrl = withSource
    ? `https://d016.example/team/${fullName.toLocaleLowerCase("en-US").replaceAll(" ", "-")}`
    : null;
  return {
    idempotencyKey: digest(`d016-person:${fullName}`),
    fullName,
    normalizedName: fullName.toLocaleLowerCase("en-US"),
    sourceType: "PUBLIC_WEB" as const,
    sourceProvider: "d016-fixture",
    sourceUrl,
    confidence,
    roles: {
      create: {
        idempotencyKey: digest(`d016-role:${fullName}:${title}`),
        title,
        normalizedTitle: title.toLocaleLowerCase("en-US"),
        seniority,
        departments: [],
        sourceUrl,
        confidence,
      },
    },
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface SelectionResponse {
  id: string;
  cached: boolean;
  status: "COMPLETE" | "REVIEW_REQUIRED";
  missingSlots: Array<"PRIMARY" | "SECONDARY" | "FALLBACK">;
  warnings: string[];
  assignments: Array<{
    slot: "PRIMARY" | "SECONDARY" | "FALLBACK";
    reasons: string[];
    components: Record<string, number>;
    reviewUrl: string | null;
    person: {
      fullName: string;
      profileUrl: string | null;
      sourceProvider: string;
      sourceUrl: string | null;
    };
    role: { title: string; sourceUrl: string | null };
  }>;
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
