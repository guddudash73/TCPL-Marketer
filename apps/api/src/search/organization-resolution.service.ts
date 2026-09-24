import { Inject, Injectable } from "@nestjs/common";
import type { SearchResult } from "@tcpl-marketer/ai-contracts";

import { DatabaseService } from "../database/database.service.js";

interface DiscoveryGeography {
  countries: string[];
  states: string[];
  cities: string[];
}

export interface PersistedDiscovery {
  organizationIds: string[];
  candidateIds: string[];
}

interface NormalizedOrganization {
  name: string;
  normalizedName: string;
  domain: string | null;
  websiteUrl: string | null;
  location: string;
  normalizedLocation: string;
  fallbackKey: string;
}

@Injectable()
export class OrganizationResolutionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async persistDiscovery(
    campaignId: string,
    geography: DiscoveryGeography,
    results: SearchResult[],
  ): Promise<PersistedDiscovery> {
    const organizationIds = new Set<string>();
    const candidateIds: string[] = [];

    for (const result of results) {
      const persisted = await this.persistResult(campaignId, geography, result);
      organizationIds.add(persisted.organizationId);
      if (!candidateIds.includes(persisted.candidateId)) {
        candidateIds.push(persisted.candidateId);
      }
    }

    return { organizationIds: [...organizationIds], candidateIds };
  }

  private async persistResult(
    campaignId: string,
    geography: DiscoveryGeography,
    result: SearchResult,
  ): Promise<{ organizationId: string; candidateId: string }> {
    const normalized = normalizeOrganization(result, geography);

    try {
      return await this.persistNormalized(campaignId, result, normalized);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      return this.persistNormalized(campaignId, result, normalized);
    }
  }

  private async persistNormalized(
    campaignId: string,
    result: SearchResult,
    normalized: NormalizedOrganization,
  ): Promise<{ organizationId: string; candidateId: string }> {
    return this.database.client.$transaction(async (transaction) => {
      let organization = normalized.domain
        ? await transaction.organization.findUnique({
            where: { normalizedDomain: normalized.domain },
          })
        : await transaction.organization.findUnique({
            where: { fallbackKey: normalized.fallbackKey },
          });

      if (!organization && !normalized.domain) {
        const nameLocationMatches = await transaction.organization.findMany({
          where: {
            normalizedName: normalized.normalizedName,
            normalizedLocation: normalized.normalizedLocation,
          },
          take: 2,
        });
        if (nameLocationMatches.length === 1) {
          organization = nameLocationMatches[0]!;
        }
      }

      if (!organization && normalized.domain) {
        const domainlessMatch = await transaction.organization.findUnique({
          where: { fallbackKey: normalized.fallbackKey },
        });
        if (domainlessMatch?.normalizedDomain === null) {
          organization = domainlessMatch;
        }
      }

      if (!organization) {
        organization = await transaction.organization.create({
          data: {
            name: normalized.name,
            normalizedName: normalized.normalizedName,
            aliases: [normalized.name],
            domain: normalized.domain,
            normalizedDomain: normalized.domain,
            websiteUrl: normalized.websiteUrl,
            location: normalized.location,
            normalizedLocation: normalized.normalizedLocation,
            fallbackKey: normalized.domain ? null : normalized.fallbackKey,
          },
        });
      } else {
        const aliases = [...new Set([...organization.aliases, normalized.name])];
        organization = await transaction.organization.update({
          where: { id: organization.id },
          data: {
            aliases,
            domain: organization.domain ?? normalized.domain,
            normalizedDomain:
              organization.normalizedDomain ?? normalized.domain,
            websiteUrl: organization.websiteUrl ?? normalized.websiteUrl,
          },
        });
      }

      const candidate = await transaction.leadCandidate.upsert({
        where: {
          campaignId_organizationId: {
            campaignId,
            organizationId: organization.id,
          },
        },
        create: {
          campaignId,
          organizationId: organization.id,
          idempotencyKey: `discovery:${campaignId}:${organization.id}`,
          sourceUrl: result.sourceUrl,
          sourceTitle: result.sourceTitle,
          summary: result.summary,
          evidenceSnippet: result.evidenceSnippet,
          searchStrategyType: result.strategyType,
          searchQuery: result.query,
        },
        update: {
          sourceUrl: result.sourceUrl,
          sourceTitle: result.sourceTitle,
          summary: result.summary,
          evidenceSnippet: result.evidenceSnippet,
          searchStrategyType: result.strategyType,
          searchQuery: result.query,
        },
      });

      return { organizationId: organization.id, candidateId: candidate.id };
    });
  }
}

export function normalizeOrganizationName(value: string): string {
  const tokens = normalizeText(value)
    .replace(/\band\b/g, "and")
    .split(" ")
    .filter(Boolean);
  const legalSuffixes = new Set([
    "co",
    "company",
    "corp",
    "corporation",
    "gmbh",
    "inc",
    "incorporated",
    "limited",
    "llc",
    "ltd",
    "plc",
  ]);
  while (tokens.length > 1 && legalSuffixes.has(tokens.at(-1)!)) tokens.pop();
  return tokens.join(" ");
}

export function normalizeDomain(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Organization website must use HTTP or HTTPS");
  }
  return url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
}

function normalizeOrganization(
  result: SearchResult,
  geography: DiscoveryGeography,
): NormalizedOrganization {
  const websiteUrl = result.websiteUrl
    ? canonicalOrganizationWebsite(result.websiteUrl)
    : null;
  const domain = websiteUrl ? normalizeDomain(websiteUrl) : null;
  const campaignLocation = [
    ...geography.cities,
    ...geography.states,
    ...geography.countries,
  ].join(", ");
  const location = (result.organizationLocation ?? campaignLocation) || "Unknown";
  const normalizedName = normalizeOrganizationName(result.organizationName);
  const normalizedLocation = normalizeText(location);

  return {
    name: result.organizationName.trim(),
    normalizedName,
    domain,
    websiteUrl,
    location: location.trim(),
    normalizedLocation,
    fallbackKey: `${normalizedName}|${normalizedLocation}`,
  };
}

function canonicalOrganizationWebsite(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Organization website must use HTTP or HTTPS");
  }
  url.hostname = normalizeDomain(value);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}
