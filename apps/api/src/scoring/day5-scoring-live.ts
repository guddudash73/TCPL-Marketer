import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@tcpl-marketer/database";

import { CrawlRunner } from "../crawler/crawl-runner.js";
import type { DatabaseService } from "../database/database.service.js";

const SOURCE_URL = "https://www.ascension-landsurveying.com/";
const n8nBaseUrl = (process.env.N8N_BASE_URL ?? "http://localhost:5678").replace(
  /\/$/,
  "",
);
const serviceSecret = process.env.N8N_SERVICE_SECRET;

if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_RESEARCH_MODEL) {
  throw new Error(
    "Set OPENAI_API_KEY and OPENAI_RESEARCH_MODEL before running D015 acceptance",
  );
}
if (!serviceSecret) {
  throw new Error("Set N8N_SERVICE_SECRET before running D015 acceptance");
}

const database = createPrismaClient();
try {
  const [actor, organization] = await Promise.all([
    database.user.findFirst({
      where: {
        status: "ACTIVE",
        roles: { some: { role: { name: { in: ["ADMIN", "MANAGER"] } } } },
      },
    }),
    database.organization.findFirst({
      where: { domain: "ascension-landsurveying.com" },
    }),
  ]);
  if (!actor || !organization) {
    throw new Error(
      "Seed an ADMIN or MANAGER and the controlled Ascension discovery candidate first",
    );
  }

  const suffix = randomUUID();
  const sector = await database.sector.create({
    data: {
      name: "Geospatial surveying",
      slug: `d015-geospatial-${suffix}`,
      terminology: ["land surveying"],
      capabilities: {
        create: {
          name: "LiDAR",
          slug: `d015-lidar-${suffix}`,
          businessProblems: [],
        },
      },
    },
    include: { capabilities: true },
  });
  const capability = sector.capabilities[0];
  if (!capability) throw new Error("D015 capability fixture was not created");

  const campaign = await database.campaign.create({
    data: {
      name: `D015 Scoring Acceptance ${new Date().toISOString()}`,
      sectorId: sector.id,
      createdByUserId: actor.id,
      researchDepth: "STANDARD",
      countries: ["United States"],
      targetLeadCount: 1,
      minimumScore: 70,
      sectorFitWeight: 0,
      capabilityMatchWeight: 100,
      targetClientFitWeight: 0,
      outsourcingWeight: 0,
      buyingIntentWeight: 0,
      businessMomentumWeight: 0,
      decisionMakerWeight: 0,
      contactConfidenceWeight: 0,
      dailyEmailLimit: 1,
      capabilities: { create: { capabilityId: capability.id } },
    },
  });
  const candidate = await database.leadCandidate.create({
    data: {
      campaignId: campaign.id,
      organizationId: organization.id,
      idempotencyKey: `d015-live:${suffix}`,
      sourceUrl: SOURCE_URL,
      sourceTitle: "Ascension Land Surveying",
      summary: "Controlled D015 qualified-company scoring candidate.",
      evidenceSnippet: "Official company website selected for controlled review.",
      searchStrategyType: "D015_ACCEPTANCE",
      searchQuery: "Ascension Land Surveying LiDAR",
    },
  });

  const crawler = new CrawlRunner({ client: database } as DatabaseService);
  const crawl = await crawler.run(organization.id, SOURCE_URL, async () => ({
    homepageUrl: SOURCE_URL,
    robotsUrl: new URL("/robots.txt", SOURCE_URL).toString(),
    sitemapUrls: [],
    pageUrls: [SOURCE_URL],
  }));
  if (crawl.pages.length !== 1) {
    throw new Error("The controlled company page was not persisted");
  }

  const first = await invokeScoring(candidate.id);
  assertAccepted(first, candidate.id);
  if (first.research.profile.extraction.cached) {
    throw new Error("D015 acceptance requires a fresh v2 extraction on the first run");
  }
  const repeated = await invokeScoring(candidate.id);
  assertAccepted(repeated, candidate.id);
  if (
    repeated.research.profile.extraction.id !==
      first.research.profile.extraction.id ||
    repeated.research.profile.extraction.cached !== true ||
    repeated.scoring.id !== first.scoring.id ||
    repeated.scoring.cached !== true
  ) {
    throw new Error("Repeat n8n scoring did not reuse the persisted research and score");
  }

  const persisted = await database.leadScore.findUniqueOrThrow({
    where: { id: first.scoring.id },
    include: { leadCandidate: { include: { organization: true } } },
  });
  const scoreCount = await database.leadScore.count({
    where: { leadCandidateId: candidate.id },
  });
  if (!persisted.qualified || scoreCount !== 1) {
    throw new Error("Qualified score persistence or idempotency verification failed");
  }

  const evidence = first.research.profile.claims
    .filter((claim) =>
      claim.sources.some(({ id }) => first.scoring.result.evidenceIds.includes(id)),
    )
    .map((claim) => ({
      type: claim.type,
      statement: claim.statement,
      sources: claim.sources.map(({ id, url, title, contentHash }) => ({
        id,
        url,
        title,
        contentHash,
      })),
    }));
  if (evidence.length === 0) {
    throw new Error("The persisted qualified score has no reviewable source evidence");
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        campaignId: campaign.id,
        candidateId: candidate.id,
        organizationId: organization.id,
        organizationName: organization.name,
        crawlRunId: crawl.runId,
        n8nExecutionIds: [first.executionId, repeated.executionId],
        extraction: first.research.profile.extraction,
        score: {
          id: persisted.id,
          value: persisted.score,
          grade: persisted.grade,
          qualified: persisted.qualified,
          candidateStatus: repeated.scoring.candidateStatus,
          recommendedAction: persisted.recommendedAction,
          weights: persisted.weights,
          components: persisted.components,
          reasons: persisted.reasons,
          evidenceIds: persisted.evidenceIds,
          cachedOnRepeat: repeated.scoring.cached,
        },
        persistence: { scoreCount },
        evidence,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await database.$disconnect();
}

type WorkflowResponse = {
  executionId: string;
  research: {
    profile: {
      extraction: {
        id: string;
        prompt: { name: string; version: string };
        cached: boolean;
      };
      claims: Array<{
        type: string;
        statement: string;
        sources: Array<{
          id: string;
          url: string;
          title: string | null;
          contentHash: string;
        }>;
      }>;
    };
  };
  scoring: {
    id: string;
    leadCandidateId: string;
    candidateStatus: string;
    cached: boolean;
    result: {
      score: number;
      grade: string;
      qualified: boolean;
      recommendedAction: string;
      components: Array<{
        key: string;
        rawScore: number;
        evidenceIds: string[];
      }>;
      evidenceIds: string[];
    };
  };
};

async function invokeScoring(candidateId: string): Promise<WorkflowResponse> {
  const response = await fetch(`${n8nBaseUrl}/webhook/company-research`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${serviceSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ candidateId }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `n8n D015 scoring returned ${response.status}: ${body.slice(0, 500)}`,
    );
  }
  return (await response.json()) as WorkflowResponse;
}

function assertAccepted(response: WorkflowResponse, candidateId: string): void {
  if (response.research.profile.extraction.prompt.version !== "v2") {
    throw new Error("D015 requires company-claim-extraction:v2");
  }
  if (
    response.scoring.leadCandidateId !== candidateId ||
    response.scoring.result.qualified !== true ||
    response.scoring.result.grade === "REJECT" ||
    !["QUALIFIED", "BDE_REVIEW"].includes(response.scoring.candidateStatus)
  ) {
    throw new Error("The controlled company did not produce a qualified score");
  }
  const capability = response.scoring.result.components.find(
    ({ key }) => key === "capabilityMatch",
  );
  if (!capability || capability.rawScore !== 100 || capability.evidenceIds.length === 0) {
    throw new Error("Capability-fit scoring is not fully backed by source evidence");
  }
}
