import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@tcpl-marketer/database";
import { normalizePersonCandidate } from "@tcpl-marketer/validation";
import { afterAll, describe, expect, it } from "vitest";

import { DatabaseService } from "../src/database/database.service.js";
import { PeoplePersistenceService } from "../src/people/people-persistence.service.js";

const database = createPrismaClient();
const service = new PeoplePersistenceService({
  client: database,
} as DatabaseService);
let organizationId = "";

describe("provider-independent people persistence", () => {
  afterAll(async () => {
    try {
      if (organizationId) {
        await database.organization.delete({ where: { id: organizationId } });
      }
    } finally {
      await database.$disconnect();
    }
  });

  it("creates one normalized person and current role idempotently", async () => {
    const organization = await database.organization.create({
      data: {
        name: "D016a Survey Company",
        normalizedName: `d016a-${randomUUID()}`,
        location: "Colorado",
        normalizedLocation: "colorado",
      },
    });
    organizationId = organization.id;
    const candidate = normalizePersonCandidate({
      fullName: "  Jordan   Smith ",
      location: "Denver, Colorado",
      profileUrl: "https://example.test/team/jordan-smith",
      source: {
        type: "PUBLIC_WEB",
        provider: "company-research",
        externalId: null,
        url: "https://example.test/team",
      },
      confidence: 0.91,
      role: {
        title: " Director   of Surveying ",
        seniority: "Director",
        departments: ["Surveying"],
        isCurrent: true,
        sourceUrl: "https://example.test/team",
        confidence: 0.95,
      },
    });

    const first = await service.persistCandidate(organization.id, candidate);
    const repeated = await service.persistCandidate(organization.id, candidate);

    expect(repeated.person.id).toBe(first.person.id);
    expect(repeated.role.id).toBe(first.role.id);
    expect(first).toMatchObject({
      person: {
        organizationId: organization.id,
        fullName: "Jordan   Smith",
        normalizedName: "jordan smith",
        sourceProvider: "company-research",
        sourcePersonId: null,
      },
      role: {
        title: "Director   of Surveying",
        normalizedTitle: "director of surveying",
        seniority: "Director",
        departments: ["Surveying"],
        isCurrent: true,
      },
    });
    expect(
      await database.person.count({ where: { organizationId } }),
    ).toBe(1);
    expect(
      await database.personRole.count({ where: { personId: first.person.id } }),
    ).toBe(1);
  });
});
