import { createHash, randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
import { createPrismaClient } from "@tcpl-marketer/database";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../src/bootstrap.js";
import { serviceHeaders } from "./support/service-auth.js";

const database = createPrismaClient();
const serviceSecret = "f002-test-service-secret-with-sufficient-entropy";

describe("F002 company-fit evidence persistence and API", () => {
  let app: INestApplication | undefined;
  const organizationIds: string[] = [];
  const originalSecret = process.env.N8N_SERVICE_SECRET;
  let organizationId = "";
  let otherOrganizationId = "";
  let headcountSourceId = "";
  let compatibleHeadcountSourceId = "";
  let conflictingHeadcountSourceId = "";
  let geographySourceId = "";
  let conflictingGeographySourceId = "";
  let businessModelSourceId = "";
  let conflictingBusinessModelSourceId = "";
  let teamCardSourceId = "";
  let negatedHeadcountSourceId = "";
  let negatedGeographySourceId = "";
  let negatedBusinessModelSourceId = "";
  let foreignSourceId = "";
  let headcountCapturedAt = new Date(0);

  beforeAll(async () => {
    process.env.N8N_SERVICE_SECRET = serviceSecret;
    const organization = await createOrganization("F002 Evidence Company");
    const otherOrganization = await createOrganization("F002 Other Company");
    organizationId = organization.id;
    otherOrganizationId = otherOrganization.id;
    await database.organization.update({ where: { id: organizationId }, data: { normalizedDomain: "f002.example" } });
    organizationIds.push(organizationId, otherOrganizationId);

    const headcount = await createEvidenceSource(
      organizationId,
      "https://f002.example/about",
      "Official company profile reports 50 to 100 employees.",
      new Date("2026-09-01T00:00:00.000Z"),
    );
    headcountSourceId = headcount.id;
    headcountCapturedAt = headcount.capturedAt;
    compatibleHeadcountSourceId = (
      await createEvidenceSource(
        organizationId,
        "https://f002.example/company-facts",
        "Company facts report 70 to 90 employees.",
      )
    ).id;
    conflictingHeadcountSourceId = (
      await createEvidenceSource(
        organizationId,
        "https://registry.example/f002",
        "F002 Evidence Company has 200 to 250 employees.",
      )
    ).id;
    geographySourceId = (
      await createEvidenceSource(
        organizationId,
        "https://f002.example/locations",
        "The company operates in the United States.",
      )
    ).id;
    conflictingGeographySourceId = (
      await createEvidenceSource(
        organizationId,
        "https://registry.example/f002-location",
        "F002 Evidence Company is headquartered in India.",
      )
    ).id;
    businessModelSourceId = (
      await createEvidenceSource(
        organizationId,
        "https://f002.example/services",
        "The company provides project-based mapping services.",
      )
    ).id;
    conflictingBusinessModelSourceId = (
      await createEvidenceSource(
        organizationId,
        "https://registry.example/f002-business-model",
        "F002 Evidence Company operates as subscription software.",
      )
    ).id;
    teamCardSourceId = (
      await createEvidenceSource(
        organizationId,
        "https://f002.example/team",
        "Our team of 3 employees is available for customer support.",
      )
    ).id;
    negatedHeadcountSourceId = (
      await createEvidenceSource(
        organizationId,
        "https://f002.example/about-size",
        "The company does not employ 50 employees.",
      )
    ).id;
    negatedGeographySourceId = (
      await createEvidenceSource(
        organizationId,
        "https://f002.example/india",
        "The company does not operate in India.",
      )
    ).id;
    negatedBusinessModelSourceId = (
      await createEvidenceSource(
        organizationId,
        "https://f002.example/model",
        "The company is not subscription software.",
      )
    ).id;
    foreignSourceId = (
      await createEvidenceSource(
        otherOrganizationId,
        "https://other-f002.example/about",
        "A separate company has 500 employees.",
      )
    ).id;

    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    try {
      if (organizationIds.length > 0) {
        await database.companyFitObservation.deleteMany({
          where: { organizationId: { in: organizationIds } },
        });
        await database.crawlRun.deleteMany({
          where: { organizationId: { in: organizationIds } },
        });
        await database.organization.deleteMany({
          where: { id: { in: organizationIds } },
        });
      }
      if (app) await app.close();
    } finally {
      restoreEnvironment("N8N_SERVICE_SECRET", originalSecret);
      await database.$disconnect();
    }
  });

  it("persists explicit unknowns and returns source-backed facts with freshness", async () => {
    const path = `/internal/organizations/${organizationId}/company-fit`;
    await request(app!.getHttpServer()).post(path).expect(401);

    const unknown = await signedPost(path, {
      observations: [{ factType: "HEADCOUNT", state: "UNKNOWN" }],
    }).expect(201);
    expect(unknown.body.facts.headcount).toMatchObject({
      state: "UNKNOWN",
      observations: [
        {
          state: "UNKNOWN",
          headcount: null,
          value: null,
          confidence: null,
          capturedAt: null,
          freshness: {
            state: "UNKNOWN",
            publishedAt: null,
            capturedAt: null,
          },
          source: null,
        },
      ],
    });
    expect(
      await database.companyFitObservation.count({
        where: { organizationId, factType: "HEADCOUNT", state: "UNKNOWN" },
      }),
    ).toBe(1);

    const recorded = await signedPost(path, {
      observations: [
        {
          factType: "HEADCOUNT",
          state: "VERIFIED",
          minimum: 50,
          maximum: 100,
          sourceId: headcountSourceId,
          evidenceExcerpt: "Official company profile reports 50 to 100 employees.",
          confidence: 0.9,
          conflictsWithSourceIds: [],
        },
        {
          factType: "GEOGRAPHY",
          state: "VERIFIED",
          value: "United States",
          sourceId: geographySourceId,
          evidenceExcerpt: "The company operates in the United States.",
          confidence: 0.95,
          conflictsWithSourceIds: [],
        },
        {
          factType: "BUSINESS_MODEL",
          state: "VERIFIED",
          value: "Project-based mapping services",
          sourceId: businessModelSourceId,
          evidenceExcerpt: "The company provides project-based mapping services.",
          confidence: 0.85,
          conflictsWithSourceIds: [],
        },
      ],
    }).expect(201);

    expect(recorded.body.facts.headcount).toMatchObject({
      state: "VERIFIED",
      observations: [
        {
          headcount: { minimum: 50, maximum: 100 },
          confidence: 0.9,
          capturedAt: headcountCapturedAt.toISOString(),
          freshness: {
            state: "PUBLISHED_AT_KNOWN",
            publishedAt: "2026-09-01T00:00:00.000Z",
            capturedAt: headcountCapturedAt.toISOString(),
          },
          source: {
            id: headcountSourceId,
            url: "https://f002.example/about",
            publishedAt: "2026-09-01T00:00:00.000Z",
          },
        },
      ],
    });
    expect(recorded.body.facts.geographies.observations[0]).toMatchObject({
      value: "United States",
      source: { id: geographySourceId },
    });
    expect(recorded.body.facts.businessModels.observations[0]).toMatchObject({
      value: "Project-based mapping services",
      source: { id: businessModelSourceId },
    });
    expect(
      await database.companyFitObservation.count({ where: { organizationId } }),
    ).toBe(3);

    const duplicateRequest = {
      observations: [
        {
          factType: "HEADCOUNT",
          state: "VERIFIED",
          minimum: 50,
          maximum: 100,
          sourceId: headcountSourceId,
          evidenceExcerpt: "Official company profile reports 50 to 100 employees.",
          confidence: 0.9,
          conflictsWithSourceIds: [],
        },
      ],
    };
    const duplicateResponses = await Promise.all([
      signedPost(path, duplicateRequest),
      signedPost(path, duplicateRequest),
    ]);
    expect(duplicateResponses.map(({ status }) => status)).toEqual([201, 201]);
    expect(
      await database.companyFitObservation.count({ where: { organizationId } }),
    ).toBe(3);

    const profile = await signedGet(path).expect(200);
    expect(profile.body).toEqual(recorded.body);
  });

  it("serializes concurrent evidence and preserves non-overlapping conflicts", async () => {
    const path = `/internal/organizations/${organizationId}/company-fit`;
    const [compatible, conflicting] = await Promise.all([
      signedPost(path, {
        observations: [
          {
            factType: "HEADCOUNT",
            state: "VERIFIED",
            minimum: 70,
            maximum: 90,
            sourceId: compatibleHeadcountSourceId,
            evidenceExcerpt: "Company facts report 70 to 90 employees.",
            confidence: 0.8,
            conflictsWithSourceIds: [],
          },
        ],
      }),
      signedPost(path, {
        observations: [
          {
            factType: "HEADCOUNT",
            state: "VERIFIED",
            minimum: 200,
            maximum: 250,
            sourceId: conflictingHeadcountSourceId,
            evidenceExcerpt: "F002 Evidence Company has 200 to 250 employees.",
            confidence: 0.75,
            conflictsWithSourceIds: [],
          },
        ],
      }),
    ]);
    expect([compatible.status, conflicting.status]).toEqual([201, 201]);

    const profile = await signedGet(path).expect(200);
    expect(profile.body.facts.headcount.state).toBe("CONFLICT");
    expect(profile.body.facts.headcount.observations).toHaveLength(3);
    expect(
      profile.body.facts.headcount.observations.map(
        (observation: { headcount: { minimum: number; maximum: number } }) =>
          observation.headcount,
      ),
    ).toEqual(
      expect.arrayContaining([
        { minimum: 50, maximum: 100 },
        { minimum: 70, maximum: 90 },
        { minimum: 200, maximum: 250 },
      ]),
    );
    expect(
      profile.body.facts.headcount.observations.every(
        (observation: { state: string }) => observation.state === "CONFLICT",
      ),
    ).toBe(true);
  });

  it("persists explicitly cited text conflicts without overwriting either source", async () => {
    const path = `/internal/organizations/${organizationId}/company-fit`;
    const response = await signedPost(path, {
      observations: [
        {
          factType: "GEOGRAPHY",
          state: "VERIFIED",
          value: "India",
          sourceId: conflictingGeographySourceId,
          evidenceExcerpt: "F002 Evidence Company is headquartered in India.",
          confidence: 0.8,
          conflictsWithSourceIds: [geographySourceId],
        },
      ],
    }).expect(201);

    expect(response.body.facts.geographies.state).toBe("CONFLICT");
    expect(response.body.facts.geographies.observations).toHaveLength(2);
    expect(
      response.body.facts.geographies.observations.map(
        (observation: { value: string }) => observation.value,
      ),
    ).toEqual(expect.arrayContaining(["United States", "India"]));
    expect(
      response.body.facts.geographies.observations.every(
        (observation: { state: string }) => observation.state === "CONFLICT",
      ),
    ).toBe(true);

    const businessConflict = await signedPost(path, {
      observations: [
        {
          factType: "BUSINESS_MODEL",
          state: "VERIFIED",
          value: "Subscription software",
          sourceId: conflictingBusinessModelSourceId,
          evidenceExcerpt: "F002 Evidence Company operates as subscription software.",
          confidence: 0.8,
          conflictsWithSourceIds: [businessModelSourceId],
        },
      ],
    }).expect(201);
    expect(businessConflict.body.facts.businessModels.state).toBe("CONFLICT");
    expect(
      businessConflict.body.facts.businessModels.observations.map(
        (observation: { value: string }) => observation.value,
      ),
    ).toEqual(
      expect.arrayContaining([
        "Project-based mapping services",
        "Subscription software",
      ]),
    );
  });

  it("rejects partial, team-card, negated and foreign evidence without persisting facts", async () => {
    const path = `/internal/organizations/${organizationId}/company-fit`;
    const before = await database.companyFitObservation.count({
      where: { organizationId },
    });

    await signedPost(path, { observations: [] }).expect(400);
    await signedPost(path, {
      observations: [
        {
          factType: "HEADCOUNT",
          state: "VERIFIED",
          minimum: 3,
          maximum: 3,
          sourceId: teamCardSourceId,
          confidence: 0.5,
          conflictsWithSourceIds: [],
        },
      ],
    }).expect(400);

    await signedPost(path, {
      observations: [
        {
          factType: "HEADCOUNT",
          state: "VERIFIED",
          minimum: 300,
          maximum: 100,
          sourceId: headcountSourceId,
          evidenceExcerpt: "Official company profile reports 50 to 100 employees.",
          confidence: 0.9,
          conflictsWithSourceIds: [],
        },
      ],
    }).expect(400);
    await signedPost(path, {
      observations: [
        {
          factType: "HEADCOUNT",
          state: "VERIFIED",
          minimum: 500,
          maximum: 500,
          sourceId: foreignSourceId,
          evidenceExcerpt: "A separate company has 500 employees.",
          confidence: 0.9,
          conflictsWithSourceIds: [],
        },
      ],
    }).expect(422);
    await signedPost(path, {
      observations: [
        {
          factType: "GEOGRAPHY",
          state: "VERIFIED",
          value: "United States",
          sourceId: geographySourceId,
          evidenceExcerpt: "This sentence is not in the stored document.",
          confidence: 0.5,
          conflictsWithSourceIds: [],
        },
      ],
    }).expect(422);
    await signedPost(path, {
      observations: [
        {
          factType: "HEADCOUNT",
          state: "VERIFIED",
          minimum: 3,
          maximum: 3,
          sourceId: teamCardSourceId,
          evidenceExcerpt:
            "Our team of 3 employees is available for customer support.",
          confidence: 0.5,
          conflictsWithSourceIds: [],
        },
      ],
    }).expect(422);
    await signedPost(path, {
      observations: [
        {
          factType: "HEADCOUNT",
          state: "VERIFIED",
          minimum: 50,
          maximum: 50,
          sourceId: negatedHeadcountSourceId,
          evidenceExcerpt: "The company does not employ 50 employees.",
          confidence: 0.5,
          conflictsWithSourceIds: [],
        },
      ],
    }).expect(422);
    await signedPost(path, {
      observations: [
        {
          factType: "GEOGRAPHY",
          state: "VERIFIED",
          value: "India",
          sourceId: negatedGeographySourceId,
          evidenceExcerpt: "The company does not operate in India.",
          confidence: 0.5,
          conflictsWithSourceIds: [],
        },
      ],
    }).expect(422);
    await signedPost(path, {
      observations: [
        {
          factType: "BUSINESS_MODEL",
          state: "VERIFIED",
          value: "Subscription software",
          sourceId: negatedBusinessModelSourceId,
          evidenceExcerpt: "The company is not subscription software.",
          confidence: 0.5,
          conflictsWithSourceIds: [],
        },
      ],
    }).expect(422);
    await signedPost(path, {
      observations: [
        {
          factType: "BUSINESS_MODEL",
          state: "VERIFIED",
          value: "Subscription software",
          sourceId: businessModelSourceId,
          evidenceExcerpt: "The company provides project-based mapping services.",
          confidence: 0.5,
          conflictsWithSourceIds: [],
        },
      ],
    }).expect(422);

    expect(
      await database.companyFitObservation.count({ where: { organizationId } }),
    ).toBe(before);
  });

  it("rejects qualified, one-sided, future, and misleading exact-match evidence", async () => {
    const path = `/internal/organizations/${organizationId}/company-fit`;
    const before = await database.companyFitObservation.count({
      where: { organizationId },
    });
    const unsupported = [
      {
        text: "The company has approximately 50 employees.",
        factType: "HEADCOUNT",
        minimum: 50,
        maximum: 50,
      },
      {
        text: "The company has at least 50 employees.",
        factType: "HEADCOUNT",
        minimum: 50,
        maximum: 50,
      },
      {
        text: "The company has fewer than 50 employees.",
        factType: "HEADCOUNT",
        minimum: 50,
        maximum: 50,
      },
      {
        text: "The company has as many as 50 employees.",
        factType: "HEADCOUNT",
        minimum: 50,
        maximum: 50,
      },
      {
        text: "The company has 50+ employees.",
        factType: "HEADCOUNT",
        minimum: 50,
        maximum: 50,
      },
      {
        text: "The company has 50 employees in its India office.",
        factType: "HEADCOUNT",
        minimum: 50,
        maximum: 50,
      },
      {
        text: "The company previously had 50 employees.",
        factType: "HEADCOUNT",
        minimum: 50,
        maximum: 50,
      },
      {
        text: "Does the company have 50 employees?",
        factType: "HEADCOUNT",
        minimum: 50,
        maximum: 50,
      },
      {
        text: "The company employs 500 employees.",
        factType: "HEADCOUNT",
        minimum: 50,
        maximum: 50,
      },
      {
        text: "The company may have 50 employees.",
        excerpt: "50 employees",
        factType: "HEADCOUNT",
        minimum: 50,
        maximum: 50,
      },
      {
        text: "Our team of 3 employees is available for support.",
        excerpt: "3 employees",
        factType: "HEADCOUNT",
        minimum: 3,
        maximum: 3,
      },
      {
        text: "The company may operate in India.",
        factType: "GEOGRAPHY",
        value: "India",
      },
      {
        text: "The company does not operate in India.",
        excerpt: "India",
        factType: "GEOGRAPHY",
        value: "India",
      },
      {
        text: "The company plans to operate in India.",
        factType: "GEOGRAPHY",
        value: "India",
      },
      {
        text: "The company operates in Indiana.",
        factType: "GEOGRAPHY",
        value: "India",
      },
      {
        text: "The company mentions India in a case study.",
        factType: "GEOGRAPHY",
        value: "India",
      },
      {
        text: "The company appears to offer subscription software.",
        factType: "BUSINESS_MODEL",
        value: "subscription software",
      },
      {
        text: "The company appears to offer subscription software.",
        excerpt: "subscription software",
        factType: "BUSINESS_MODEL",
        value: "subscription software",
      },
      {
        text: "The company is evaluating subscription software.",
        factType: "BUSINESS_MODEL",
        value: "subscription software",
      },
    ] as const;

    for (const [index, example] of unsupported.entries()) {
      const source = await createEvidenceSource(
        organizationId,
        `https://f002.example/ambiguous-${index}`,
        example.text,
      );
      const observation = example.factType === "HEADCOUNT"
        ? {
            factType: example.factType,
            state: "VERIFIED",
            minimum: example.minimum,
            maximum: example.maximum,
            sourceId: source.id,
            evidenceExcerpt: "excerpt" in example ? example.excerpt : example.text,
            confidence: 0.5,
            conflictsWithSourceIds: [],
          }
        : {
            factType: example.factType,
            state: "VERIFIED",
            value: example.value,
            sourceId: source.id,
            evidenceExcerpt: "excerpt" in example ? example.excerpt : example.text,
            confidence: 0.5,
            conflictsWithSourceIds: [],
          };
      await signedPost(path, { observations: [observation] }).expect(422);
      expect(
        await database.companyFitObservation.count({ where: { organizationId } }),
      ).toBe(before);
    }
  });

  it("rejects facts attributed to related organizations without persisting them", async () => {
    const path = `/internal/organizations/${organizationId}/company-fit`;
    const before = await database.companyFitObservation.count({
      where: { organizationId },
    });
    const unsupported = [
      {
        text: "F002 Evidence Company partners with a supplier that has 50 employees.",
        observation: {
          factType: "HEADCOUNT",
          state: "VERIFIED",
          minimum: 50,
          maximum: 50,
          confidence: 0.8,
        },
      },
      {
        text: "A supplier of F002 Evidence Company has 50 employees.",
        observation: {
          factType: "HEADCOUNT",
          state: "VERIFIED",
          minimum: 50,
          maximum: 50,
          confidence: 0.8,
        },
      },
      {
        text: "The company works with a vendor that operates in India.",
        observation: {
          factType: "GEOGRAPHY",
          state: "VERIFIED",
          value: "India",
          confidence: 0.8,
        },
      },
      {
        text: "A customer of F002 Evidence Company operates in India.",
        observation: {
          factType: "GEOGRAPHY",
          state: "VERIFIED",
          value: "India",
          confidence: 0.8,
        },
      },
      {
        text: "The company partners with a customer that offers subscription software.",
        observation: {
          factType: "BUSINESS_MODEL",
          state: "VERIFIED",
          value: "subscription software",
          confidence: 0.8,
        },
      },
      {
        text: "An affiliate of F002 Evidence Company offers subscription software.",
        observation: {
          factType: "BUSINESS_MODEL",
          state: "VERIFIED",
          value: "subscription software",
          confidence: 0.8,
        },
      },
    ] as const;

    for (const [index, example] of unsupported.entries()) {
      const source = await createEvidenceSource(
        organizationId,
        `https://f002.example/related-${index}`,
        example.text,
      );
      await signedPost(path, {
        observations: [
          {
            ...example.observation,
            sourceId: source.id,
            evidenceExcerpt: example.text,
            conflictsWithSourceIds: [],
          },
        ],
      }).expect(422);
      expect(
        await database.companyFitObservation.count({ where: { organizationId } }),
      ).toBe(before);
    }
  });

  it("requires first-party authority and matching domain for generic subjects, across all facts", async () => {
    const path = `/internal/organizations/${organizationId}/company-fit`;
    const cases = [
      { factType: "HEADCOUNT", minimum: 42, maximum: 42, text: "We employ 42 employees." },
      { factType: "GEOGRAPHY", value: "Germany", text: "The company operates in Germany." },
      { factType: "BUSINESS_MODEL", value: "mapping services", text: "Our company provides mapping services." },
    ];
    const before = await database.companyFitObservation.count({ where: { organizationId } });
    for (const { text, ...fact } of cases) {
      for (const [url, authority] of [
        ["https://press.example/article", "THIRD_PARTY"],
        ["https://f002.example/press", "THIRD_PARTY"],
        ["https://f002.example.evil.example/article", "FIRST_PARTY"],
      ]) {
        const source = await createEvidenceSource(organizationId, url!, text);
        await database.source.update({ where: { id: source.id }, data: { authority } });
        await signedPost(path, { observations: [{ ...fact, state: "VERIFIED", sourceId: source.id, evidenceExcerpt: text, confidence: 0.9, conflictsWithSourceIds: [] }] }).expect(422);
      }
    }
    expect(await database.companyFitObservation.count({ where: { organizationId } })).toBe(before);
    const positive = await createEvidenceSource(organizationId, "https://f002.example/profile", cases[0]!.text);
    await signedPost(path, { observations: [{ factType: "HEADCOUNT", state: "VERIFIED", minimum: 42, maximum: 42, sourceId: positive.id, evidenceExcerpt: cases[0]!.text, confidence: 0.9 }] }).expect(201);
  });

  it("preserves bidirectional conflict links across concurrent retries without cross-fact contamination", async () => {
    const organization = await createOrganization("Conflict Preservation Company");
    organizationIds.push(organization.id);
    const path = `/internal/organizations/${organization.id}/company-fit`;
    const firstText = "Conflict Preservation Company operates in India. Conflict Preservation Company provides mapping services.";
    const secondText = "Conflict Preservation Company operates in Canada. Conflict Preservation Company provides software.";
    const first = await createEvidenceSource(organization.id, "https://registry.example/first", firstText);
    const second = await createEvidenceSource(organization.id, "https://registry.example/second", secondText);
    const geography = (sourceId: string, value: string, conflictsWithSourceIds: string[] = []) => ({ factType: "GEOGRAPHY", state: "VERIFIED", value, sourceId, confidence: 0.9, evidenceExcerpt: `Conflict Preservation Company operates in ${value}.`, conflictsWithSourceIds });
    await signedPost(path, { observations: [geography(first.id, "India")] }).expect(201);
    // Two operating countries and two business models can both be true.
    const compatible = await signedPost(path, { observations: [geography(second.id, "Canada")] }).expect(201);
    expect(compatible.body.facts.geographies.state).toBe("VERIFIED");
    await signedPost(path, { observations: [
      geography(second.id, "Canada", [first.id]),
      { factType: "BUSINESS_MODEL", state: "VERIFIED", value: "mapping services", sourceId: first.id, confidence: 0.9, evidenceExcerpt: "Conflict Preservation Company provides mapping services.", conflictsWithSourceIds: [] },
      { factType: "BUSINESS_MODEL", state: "VERIFIED", value: "software", sourceId: second.id, confidence: 0.9, evidenceExcerpt: "Conflict Preservation Company provides software.", conflictsWithSourceIds: [] },
    ] }).expect(201);
    await Promise.all([
      signedPost(path, { observations: [geography(second.id, "Canada")] }).expect(201),
      signedPost(path, { observations: [geography(first.id, "India"), { factType: "GEOGRAPHY", state: "UNKNOWN" }] }).expect(201),
    ]);
    const profile = await signedGet(path).expect(200);
    expect(profile.body.facts.geographies).toMatchObject({ state: "CONFLICT", observations: expect.arrayContaining([
      expect.objectContaining({ source: expect.objectContaining({ id: first.id }), conflictingSourceIds: [second.id], state: "CONFLICT" }),
      expect.objectContaining({ source: expect.objectContaining({ id: second.id }), conflictingSourceIds: [first.id], state: "CONFLICT" }),
    ]) });
    expect(profile.body.facts.geographies.observations).toHaveLength(2);
    expect(profile.body.facts.businessModels.state).toBe("VERIFIED");
    expect(profile.body.facts.businessModels.observations).toHaveLength(2);
    const before = await database.companyFitObservation.count({ where: { organizationId: organization.id } });
    await signedPost(path, { observations: [geography(second.id, "Canada", [second.id])] }).expect(422);
    expect(await database.companyFitObservation.count({ where: { organizationId: organization.id } })).toBe(before);
  });

  it("does not label old publication or recent capture as current without an age policy", async () => {
    const source = await createEvidenceSource(organizationId, "https://f002.example/old", "The company operates in Japan.", new Date("2000-01-01T00:00:00Z"));
    const path = `/internal/organizations/${organizationId}/company-fit`;
    const response = await signedPost(path, { observations: [{ factType: "GEOGRAPHY", state: "VERIFIED", value: "Japan", sourceId: source.id, evidenceExcerpt: "The company operates in Japan.", confidence: 0.8 }] }).expect(201);
    const observation = response.body.facts.geographies.observations.find((row: { source: { id: string } }) => row.source.id === source.id);
    expect(observation.freshness).toMatchObject({ currentness: "UNKNOWN", reason: "NO_AGE_POLICY_APPLIED", publishedAt: "2000-01-01T00:00:00.000Z" });
    await request(app!.getHttpServer()).get(path).expect(401);
    await signedGet(`/internal/organizations/${randomUUID()}/company-fit`).expect(404);
    await signedPost(path, { observations: [] }).expect(400);
  });

  function signedPost(path: string, body: unknown) {
    const raw = JSON.stringify(body);
    return request(app!.getHttpServer())
      .post(path)
      .set(serviceHeaders("POST", path, { body: raw }))
      .set("content-type", "application/json")
      .send(raw);
  }

  function signedGet(path: string) {
    const headers = serviceHeaders("GET", path);
    return request(app!.getHttpServer())
      .get(path)
      .set(headers);
  }
});

async function createOrganization(name: string) {
  return database.organization.create({
    data: {
      name,
      normalizedName: `${name.toLocaleLowerCase("en-US")}-${randomUUID()}`,
      normalizedDomain: null,
      websiteUrl: "https://f002.example/",
      location: "Test",
      normalizedLocation: "test",
    },
  });
}

async function createEvidenceSource(
  organizationId: string,
  url: string,
  text: string,
  publishedAt?: Date,
) {
  const crawlRun = await database.crawlRun.create({
    data: {
      organizationId,
      homepageUrl: url,
      status: "SUCCEEDED",
      completedAt: new Date(),
    },
  });
  const attempt = await database.crawlAttempt.create({
    data: {
      crawlRunId: crawlRun.id,
      requestedUrl: url,
      finalUrl: url,
      method: "HTTP",
      status: "SUCCEEDED",
      httpStatus: 200,
      title: "F002 evidence",
      textLength: text.length,
      source: {
        create: {
          organizationId,
          crawlRunId: crawlRun.id,
          url,
          title: "F002 evidence",
          publisher: new URL(url).hostname,
          sourceType: "COMPANY_FIT_TEST",
          authority: new URL(url).hostname === "f002.example" ? "FIRST_PARTY" : "THIRD_PARTY",
          publishedAt,
          contentHash: createHash("sha256").update(text).digest("hex"),
          webDocument: {
            create: { text, fetchMethod: "HTTP", httpStatus: 200 },
          },
        },
      },
    },
    include: { source: true },
  });
  return attempt.source!;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
