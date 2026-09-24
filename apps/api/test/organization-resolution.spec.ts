import { randomUUID } from "node:crypto";

import type { SearchResult } from "@tcpl-marketer/ai-contracts";
import { createPrismaClient } from "@tcpl-marketer/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { DatabaseService } from "../src/database/database.service.js";
import {
  normalizeDomain,
  normalizeOrganizationName,
  OrganizationResolutionService,
} from "../src/search/organization-resolution.service.js";

const database = createPrismaClient();
const testId = randomUUID();
const organizationIds: string[] = [];
let campaignId: string;
let sectorId: string;
let userId: string;

const results: SearchResult[] = [
  {
    organizationName: "Acme Surveying, Inc.",
    organizationLocation: "Denver, Colorado, United States",
    websiteUrl: "https://www.acme.example/about-us?source=search",
    sourceUrl: "https://directory.example/acme",
    sourceTitle: "Acme Surveying",
    summary: "A surveying company using LiDAR.",
    evidenceSnippet: "Acme provides LiDAR surveying.",
    strategyType: "DIRECT_COMPANY",
    query: "LiDAR surveying companies Colorado",
  },
  {
    organizationName: "ACME Surveying LLC",
    organizationLocation: "Denver, Colorado, United States",
    websiteUrl: "https://acme.example/services",
    sourceUrl: "https://news.example/acme-lidar",
    sourceTitle: "Acme expands LiDAR services",
    summary: "The same company found by another query.",
    evidenceSnippet: "Acme expanded its LiDAR practice.",
    strategyType: "PROJECT_AWARD",
    query: "Colorado LiDAR project awards",
  },
  {
    organizationName: "Acme Surveying Corporation",
    organizationLocation: "Denver, Colorado, United States",
    websiteUrl: null,
    sourceUrl: "https://projects.example/acme-surveying",
    sourceTitle: "Acme Surveying project",
    summary: "The same company returned without a website.",
    evidenceSnippet: "Acme Surveying delivered the project.",
    strategyType: "RFP_VENDOR",
    query: "Colorado LiDAR vendors",
  },
  {
    organizationName: "Vector Mapping Ltd.",
    organizationLocation: "Austin, Texas, United States",
    websiteUrl: null,
    sourceUrl: "https://directory.example/vector-mapping",
    sourceTitle: "Vector Mapping",
    summary: "A domainless mapping-company result.",
    evidenceSnippet: "Vector Mapping offers aerial surveying.",
    strategyType: "DIRECT_COMPANY",
    query: "Austin aerial surveying companies",
  },
  {
    organizationName: "Vector Mapping LLC",
    organizationLocation: "Austin, Texas, United States",
    websiteUrl: null,
    sourceUrl: "https://awards.example/vector-mapping",
    sourceTitle: "Vector Mapping project award",
    summary: "The same domainless company found again.",
    evidenceSnippet: "Vector Mapping received a survey award.",
    strategyType: "PROJECT_AWARD",
    query: "Texas survey project awards",
  },
];

describe("organization normalization", () => {
  it("normalizes legal suffixes, punctuation, and website hosts", () => {
    expect(normalizeOrganizationName("  Ácme Surveying, Inc. ")).toBe(
      "acme surveying",
    );
    expect(normalizeOrganizationName("ACME Surveying LLC")).toBe(
      "acme surveying",
    );
    expect(normalizeDomain("https://WWW.Example.COM/path?q=1")).toBe(
      "example.com",
    );
  });
});

describe("organization and lead-candidate persistence", () => {
  beforeAll(async () => {
    const sector = await database.sector.create({
      data: { name: `D012 Sector ${testId}`, slug: `d012-${testId}` },
    });
    sectorId = sector.id;
    const user = await database.user.create({
      data: {
        email: `d012-${testId}@example.test`,
        displayName: "D012 Test User",
        passwordHash: "not-used-by-this-integration-test",
      },
    });
    userId = user.id;
    const campaign = await database.campaign.create({
      data: {
        name: "D012 Organization Resolution",
        sectorId,
        createdByUserId: userId,
        researchDepth: "STANDARD",
        countries: ["United States"],
        targetLeadCount: 10,
        minimumScore: 70,
        dailyEmailLimit: 10,
      },
    });
    campaignId = campaign.id;
  });

  afterAll(async () => {
    try {
      if (campaignId) await database.campaign.delete({ where: { id: campaignId } });
      if (organizationIds.length > 0) {
        await database.organization.deleteMany({
          where: { id: { in: organizationIds } },
        });
      }
      if (userId) await database.user.delete({ where: { id: userId } });
      if (sectorId) await database.sector.delete({ where: { id: sectorId } });
    } finally {
      await database.$disconnect();
    }
  });

  it("deduplicates repeated domain and name-location discoveries", async () => {
    const service = new OrganizationResolutionService({
      client: database,
    } as DatabaseService);
    const geography = {
      countries: ["United States"],
      states: [],
      cities: [],
    };

    const first = await service.persistDiscovery(campaignId, geography, results);
    organizationIds.push(...first.organizationIds);
    const repeated = await service.persistDiscovery(campaignId, geography, results);

    expect(first.organizationIds).toHaveLength(2);
    expect(first.candidateIds).toHaveLength(2);
    expect(repeated).toEqual(first);
    expect(
      await database.organization.count({
        where: { id: { in: first.organizationIds } },
      }),
    ).toBe(2);
    expect(await database.leadCandidate.count({ where: { campaignId } })).toBe(2);

    const acme = await database.organization.findUniqueOrThrow({
      where: { normalizedDomain: "acme.example" },
    });
    expect(acme.websiteUrl).toBe("https://acme.example");
    expect(acme.aliases).toEqual(
      expect.arrayContaining(["Acme Surveying, Inc.", "ACME Surveying LLC"]),
    );
  });
});
