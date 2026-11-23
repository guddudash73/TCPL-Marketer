import { createHash } from "node:crypto";
import { Prisma } from "@tcpl-marketer/database";

export const diagnosticCandidateInclude = {
  campaign: {
    include: {
      capabilities: { select: { capabilityId: true } },
      targets: { select: { targetClientProfileId: true } },
    },
  },
  organization: {
    select: {
      id: true,
      name: true,
      normalizedDomain: true,
      updatedAt: true,
      sources: {
        where: { webDocument: { isNot: null } },
        orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
        take: 25,
        select: {
          id: true, url: true, title: true, contentHash: true, capturedAt: true,
          webDocument: { select: { text: true } },
        },
      },
      people: {
        select: {
          id: true,
          provenance: true,
          sourceProvider: true,
          sourceType: true,
          sourceUrl: true,
          fullName: true,
          normalizedName: true,
          confidence: true,
          updatedAt: true,
          roles: {
            where: { isCurrent: true },
            select: {
              id: true,
              sourceUrl: true,
              title: true,
              normalizedTitle: true,
              seniority: true,
              confidence: true,
              updatedAt: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.LeadCandidateInclude;

export function diagnosticSnapshotHash(candidate: {
  id: string;
  campaignId: string;
  organizationId: string;
  status: string;
  provenance: string;
  updatedAt: Date;
  campaign: {
    updatedAt: Date; provenance: string; status: string;
    capabilities?: Array<{ capabilityId: string }>;
    targets?: Array<{ targetClientProfileId: string }>;
  };
  organization: {
    name?: string;
    normalizedDomain?: string | null;
    updatedAt?: Date;
    sources: Array<{
      id: string; contentHash: string; capturedAt: Date;
      url?: string; title?: string | null; webDocument?: { text: string } | null;
    }>;
    people: Array<{
      id: string;
      provenance: string;
      sourceProvider: string;
      sourceUrl: string | null;
      roles: Array<{ id: string; sourceUrl: string | null }>;
    }>;
  };
}): string {
  return createHash("sha256")
    .update(JSON.stringify({
      candidateId: candidate.id,
      campaignId: candidate.campaignId,
      organizationId: candidate.organizationId,
      status: candidate.status,
      provenance: candidate.provenance,
      updatedAt: candidate.updatedAt,
      campaign: {
        ...candidate.campaign,
        capabilities: candidate.campaign.capabilities
          ? [...candidate.campaign.capabilities].sort((a, b) => a.capabilityId.localeCompare(b.capabilityId))
          : undefined,
        targets: candidate.campaign.targets
          ? [...candidate.campaign.targets].sort((a, b) => a.targetClientProfileId.localeCompare(b.targetClientProfileId))
          : undefined,
      },
      organization: {
        name: candidate.organization.name,
        normalizedDomain: candidate.organization.normalizedDomain,
        updatedAt: candidate.organization.updatedAt,
      },
      sources: candidate.organization.sources
        .map(({ id, url, title, contentHash, capturedAt, webDocument }) =>
          ({ id, url, title, contentHash, capturedAt, text: webDocument?.text }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      people: candidate.organization.people
        .map((person) => ({ ...person, roles: [...person.roles].sort((a, b) => a.id.localeCompare(b.id)) }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .digest("hex");
}
