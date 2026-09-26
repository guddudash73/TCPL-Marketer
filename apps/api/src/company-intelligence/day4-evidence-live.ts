import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@tcpl-marketer/database";

import { CrawlRunner } from "../crawler/crawl-runner.js";
import type { DatabaseService } from "../database/database.service.js";

const SOURCE_URL = "https://www.iana.org/about";
const n8nBaseUrl = (process.env.N8N_BASE_URL ?? "http://localhost:5678").replace(
  /\/$/,
  "",
);
const serviceSecret = process.env.N8N_SERVICE_SECRET;

if (!process.env.OPENAI_API_KEY || !process.env.OPENAI_RESEARCH_MODEL) {
  throw new Error(
    "Set OPENAI_API_KEY and OPENAI_RESEARCH_MODEL before running D014d acceptance",
  );
}
if (!serviceSecret) {
  throw new Error("Set N8N_SERVICE_SECRET before running D014d acceptance");
}

const database = createPrismaClient();
try {
  const actor = await database.user.findFirst({
    where: {
      status: "ACTIVE",
      roles: { some: { role: { name: { in: ["ADMIN", "MANAGER"] } } } },
    },
  });
  const sector = await database.sector.findFirst({ orderBy: { createdAt: "asc" } });
  if (!actor || !sector) {
    throw new Error("Seed an ADMIN or MANAGER user and configuration first");
  }

  const suffix = randomUUID();
  const campaign = await database.campaign.create({
    data: {
      name: `D014d Evidence Acceptance ${new Date().toISOString()}`,
      sectorId: sector.id,
      createdByUserId: actor.id,
      researchDepth: "STANDARD",
      countries: ["United States"],
      targetLeadCount: 1,
      minimumScore: 0,
      dailyEmailLimit: 1,
    },
  });
  const organization = await database.organization.create({
    data: {
      name: "Internet Assigned Numbers Authority",
      normalizedName: `iana-d014d-${suffix}`,
      websiteUrl: SOURCE_URL,
      location: "United States",
      normalizedLocation: "united states",
    },
  });
  const candidate = await database.leadCandidate.create({
    data: {
      campaignId: campaign.id,
      organizationId: organization.id,
      idempotencyKey: `d014d:${suffix}`,
      sourceUrl: SOURCE_URL,
      sourceTitle: "About IANA",
      summary: "Controlled D014d evidence-acceptance candidate.",
      evidenceSnippet: "IANA public about page selected for controlled verification.",
      searchStrategyType: "D014D_ACCEPTANCE",
      searchQuery: "IANA about",
    },
  });

  const crawler = new CrawlRunner({ client: database } as DatabaseService);
  const crawl = await crawler.run(organization.id, SOURCE_URL, async () => ({
    homepageUrl: new URL(SOURCE_URL).origin + "/",
    robotsUrl: new URL("/robots.txt", SOURCE_URL).toString(),
    sitemapUrls: [],
    pageUrls: [SOURCE_URL],
  }));
  if (crawl.pages.length !== 1) {
    throw new Error("The controlled source page was not persisted");
  }

  const first = await invokeResearch(candidate.id);
  if (first.research.profile.claims.length === 0) {
    throw new Error("Live structured extraction returned no supported claims");
  }
  if (
    first.research.profile.claims.some(
      (claim) => claim.sources.length === 0 || claim.sources.some(({ url }) => !url),
    )
  ) {
    throw new Error("Every persisted claim must have a stored source URL");
  }

  const repeated = await invokeResearch(candidate.id);
  if (
    repeated.research.profile.extraction.id !==
      first.research.profile.extraction.id ||
    repeated.research.profile.extraction.cached !== true
  ) {
    throw new Error("Repeat n8n research did not return the idempotent cached run");
  }

  const [runCount, claimCount, evidenceCount] = await Promise.all([
    database.claimExtractionRun.count({
      where: { organizationId: organization.id },
    }),
    database.claim.count({ where: { organizationId: organization.id } }),
    database.claimEvidence.count({
      where: { claim: { organizationId: organization.id } },
    }),
  ]);
  if (runCount !== 1 || claimCount === 0 || evidenceCount === 0) {
    throw new Error(
      `Unexpected persistence counts: runs=${runCount}, claims=${claimCount}, evidence=${evidenceCount}`,
    );
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        campaignId: campaign.id,
        candidateId: candidate.id,
        organizationId: organization.id,
        crawlRunId: crawl.runId,
        n8nExecutionIds: [first.executionId, repeated.executionId],
        extraction: first.research.profile.extraction,
        repeatCached: repeated.research.profile.extraction.cached,
        persistence: { runCount, claimCount, evidenceCount },
        claims: first.research.profile.claims.map((claim) => ({
          type: claim.type,
          statement: claim.statement,
          sources: claim.sources.map(({ id, url, title, contentHash }) => ({
            id,
            url,
            title,
            contentHash,
          })),
        })),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await database.$disconnect();
}

type ResearchResponse = {
  executionId: string;
  research: {
    candidate: { id: string; organizationId: string; status: string };
    profile: {
      extraction: {
        id: string;
        provider: string;
        model: string;
        prompt: { name: string; version: string };
        providerResponseId: string | null;
        completedAt: string;
        cached: boolean;
      };
      claims: Array<{
        id: string;
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
};

async function invokeResearch(candidateId: string): Promise<ResearchResponse> {
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
      `n8n company research returned ${response.status}: ${body.slice(0, 500)}`,
    );
  }
  return (await response.json()) as ResearchResponse;
}
