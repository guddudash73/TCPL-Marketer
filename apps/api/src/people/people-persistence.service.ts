import { createHash } from "node:crypto";

import { Injectable, NotFoundException } from "@nestjs/common";
import {
  PersonCandidateSchema,
  type PersonCandidate,
} from "@tcpl-marketer/validation";

import { DatabaseService } from "../database/database.service.js";

export interface PersistedPersonCandidate {
  person: {
    id: string;
    organizationId: string;
    fullName: string;
    normalizedName: string;
    sourceProvider: string;
    sourcePersonId: string | null;
  };
  role: {
    id: string;
    personId: string;
    title: string;
    normalizedTitle: string;
    seniority: string | null;
    departments: string[];
    isCurrent: boolean;
  };
}

@Injectable()
export class PeoplePersistenceService {
  constructor(private readonly database: DatabaseService) {}

  async persistCandidate(
    organizationId: string,
    input: PersonCandidate,
  ): Promise<PersistedPersonCandidate> {
    const candidate = PersonCandidateSchema.parse(input);
    const organization = await this.database.client.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!organization) {
      throw new NotFoundException(`Organization ${organizationId} was not found`);
    }

    const idempotencyKey = personKey(organizationId, candidate);
    return this.database.client.$transaction(async (transaction) => {
      const person = await transaction.person.upsert({
        where: { idempotencyKey },
        create: {
          organizationId,
          idempotencyKey,
          fullName: candidate.fullName,
          normalizedName: candidate.normalizedName,
          location: candidate.location,
          profileUrl: candidate.profileUrl,
          sourceType: candidate.source.type,
          sourceProvider: candidate.source.provider,
          sourcePersonId: candidate.source.externalId,
          sourceUrl: candidate.source.url,
          confidence: candidate.confidence,
        },
        update: {
          fullName: candidate.fullName,
          normalizedName: candidate.normalizedName,
          location: candidate.location,
          profileUrl: candidate.profileUrl,
          sourceType: candidate.source.type,
          sourceUrl: candidate.source.url,
          confidence: candidate.confidence,
        },
      });
      const roleIdempotencyKey = digest(
        `${person.id}|${candidate.role.normalizedTitle}|${candidate.role.isCurrent}`,
      );
      const role = await transaction.personRole.upsert({
        where: { idempotencyKey: roleIdempotencyKey },
        create: {
          personId: person.id,
          idempotencyKey: roleIdempotencyKey,
          title: candidate.role.title,
          normalizedTitle: candidate.role.normalizedTitle,
          seniority: candidate.role.seniority,
          departments: candidate.role.departments,
          isCurrent: candidate.role.isCurrent,
          sourceUrl: candidate.role.sourceUrl ?? candidate.source.url,
          confidence: candidate.role.confidence,
        },
        update: {
          title: candidate.role.title,
          seniority: candidate.role.seniority,
          departments: candidate.role.departments,
          sourceUrl: candidate.role.sourceUrl ?? candidate.source.url,
          confidence: candidate.role.confidence,
        },
      });

      return { person, role };
    });
  }
}

function personKey(
  organizationId: string,
  candidate: PersonCandidate,
): string {
  const sourceIdentity =
    candidate.source.externalId ??
    candidate.profileUrl ??
    candidate.source.url ??
    `${candidate.normalizedName}|${candidate.role.normalizedTitle}`;
  return digest(
    `${organizationId}|${candidate.source.provider.toLocaleLowerCase("en-US")}|${sourceIdentity}`,
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
