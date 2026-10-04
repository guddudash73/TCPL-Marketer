import { ClaimTypeSchema } from "@tcpl-marketer/ai-contracts";
import {
  DEFAULT_OPPORTUNITY_SCORE_WEIGHTS,
  OpportunityScoreResultSchema,
  OpportunityScoringInputSchema,
  ScoringClaimTypeSchema,
  type OpportunityScoringInput,
} from "@tcpl-marketer/validation";
import { describe, expect, it } from "vitest";

import { scoreOpportunity } from "../src/scoring/opportunity-scoring.service.js";

const ids = {
  organization: "00000000-0000-4000-8000-000000000001",
  claimCapability: "00000000-0000-4000-8000-000000000002",
  claimProject: "00000000-0000-4000-8000-000000000003",
  claimProcurement: "00000000-0000-4000-8000-000000000004",
  sourceCapability: "00000000-0000-4000-8000-000000000005",
  sourceProject: "00000000-0000-4000-8000-000000000006",
  sourceProcurement: "00000000-0000-4000-8000-000000000007",
};

function scoringInput(): OpportunityScoringInput {
  return {
    organizationId: ids.organization,
    claims: [
      {
        id: ids.claimCapability,
        type: "CAPABILITY",
        statement:
          "Acme performs aerial survey acquisition and produces point cloud data.",
        evidenceIds: [ids.sourceCapability],
      },
      {
        id: ids.claimProject,
        type: "PROJECT",
        statement: "Acme won a new regional mapping project.",
        evidenceIds: [ids.sourceProject],
      },
      {
        id: ids.claimProcurement,
        type: "PROCUREMENT",
        statement:
          "Acme published an RFP seeking subcontractor support for LiDAR processing.",
        evidenceIds: [ids.sourceProcurement],
      },
    ],
    criteria: {
      sectorTerms: ["aerial survey", "geospatial"],
      capabilityTerms: ["lidar processing", "point cloud"],
      targetClientTerms: ["aerial survey"],
      outsourcingTerms: ["subcontractor", "outsourcing"],
      negativeTerms: [],
    },
    minimumScore: 70,
  };
}

describe("opportunity scoring contract", () => {
  it("applies the approved default weights and rejects totals other than 100", () => {
    const parsed = OpportunityScoringInputSchema.parse(scoringInput());
    expect(parsed.weights).toEqual(DEFAULT_OPPORTUNITY_SCORE_WEIGHTS);
    expect(ScoringClaimTypeSchema).toBe(ClaimTypeSchema);

    expect(() =>
      OpportunityScoringInputSchema.parse({
        ...scoringInput(),
        weights: { ...DEFAULT_OPPORTUNITY_SCORE_WEIGHTS, sectorFit: 14 },
      }),
    ).toThrow("Opportunity score weights must total 100");
  });

  it("requires every company-profile claim to retain source evidence", () => {
    const input = scoringInput();
    expect(() =>
      OpportunityScoringInputSchema.parse({
        ...input,
        claims: [{ ...input.claims[0], evidenceIds: [] }],
      }),
    ).toThrow();
  });
});

describe("deterministic opportunity scoring", () => {
  it("produces explainable components, evidence lineage, and a high-intent override", () => {
    const result = scoreOpportunity(scoringInput());

    expect(OpportunityScoreResultSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      organizationId: ids.organization,
      score: 74,
      needScore: 77,
      intentScore: 96,
      grade: "B",
      qualified: true,
      recommendedAction: "URGENT_BDE_REVIEW",
      highIntentOverride: {
        applied: true,
        signal: "MATCHING_RFP",
        evidenceIds: [ids.sourceProcurement],
      },
    });
    expect(result.components).toHaveLength(8);
    expect(result.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "capabilityMatch", rawScore: 100 }),
        expect.objectContaining({ key: "buyingIntent", rawScore: 100 }),
        expect.objectContaining({ key: "decisionMakerQuality", rawScore: 0 }),
        expect.objectContaining({ key: "contactConfidence", rawScore: 0 }),
      ]),
    );
    expect(result.evidenceIds).toEqual([
      ids.sourceCapability,
      ids.sourceProcurement,
      ids.sourceProject,
    ]);
    expect(result.reasons.every((reason) => reason.length > 0)).toBe(true);
  });

  it("is repeatable, does not mutate input, and honors configurable weights", () => {
    const input = scoringInput();
    const snapshot = structuredClone(input);
    const first = scoreOpportunity(input);
    const second = scoreOpportunity(input);

    expect(first).toEqual(second);
    expect(input).toEqual(snapshot);

    const reweighted = scoreOpportunity({
      ...input,
      weights: {
        sectorFit: 0,
        capabilityMatch: 0,
        targetClientFit: 0,
        outsourcingProbability: 0,
        buyingIntent: 100,
        businessMomentum: 0,
        decisionMakerQuality: 0,
        contactConfidence: 0,
      },
    });
    expect(reweighted.score).toBe(100);
  });

  it.each([
    [90, "A_PLUS_URGENT"],
    [89, "A"],
    [80, "A"],
    [79, "B"],
    [70, "B"],
    [69, "C_REVIEW"],
    [60, "C_REVIEW"],
    [59, "REJECT"],
  ] as const)("assigns score %i to grade %s", (score, grade) => {
    const result = scoreOpportunity({
      ...scoringInput(),
      claims: [
        {
          id: ids.claimCapability,
          type: "COMPANY_FACT",
          statement: "Acme has an evidence-backed company profile.",
          evidenceIds: [ids.sourceCapability],
        },
      ],
      criteria: {
        sectorTerms: [],
        capabilityTerms: [],
        targetClientTerms: [],
        outsourcingTerms: [],
        negativeTerms: [],
      },
      downstream: {
        decisionMakerQuality: {
          score,
          confidence: 1,
          reasons: ["Controlled grade-boundary fixture."],
          evidenceIds: [ids.sourceCapability],
        },
      },
      weights: {
        sectorFit: 0,
        capabilityMatch: 0,
        targetClientFit: 0,
        outsourcingProbability: 0,
        buyingIntent: 0,
        businessMomentum: 0,
        decisionMakerQuality: 100,
        contactConfidence: 0,
      },
    });
    expect(result.grade).toBe(grade);
  });

  it("does not treat an unrelated RFP as a matching high-intent opportunity", () => {
    const input = scoringInput();
    const result = scoreOpportunity({
      ...input,
      claims: [
        {
          id: ids.claimProcurement,
          type: "PROCUREMENT",
          statement: "Acme published an RFP for office furniture.",
          evidenceIds: [ids.sourceProcurement],
        },
      ],
    });

    expect(result.highIntentOverride).toEqual({
      applied: false,
      signal: null,
      evidenceIds: [],
    });
    expect(result.grade).not.toBe("A_PLUS_URGENT");
  });

  it("keeps the numeric grade separate from an urgent high-intent flag", () => {
    const input = scoringInput();
    const result = scoreOpportunity({
      ...input,
      claims: [
        {
          id: ids.claimProcurement,
          type: "RFP",
          statement: "Acme issued an RFP for LiDAR processing.",
          evidenceIds: [ids.sourceProcurement],
        },
      ],
      criteria: {
        sectorTerms: [],
        capabilityTerms: ["lidar processing"],
        targetClientTerms: [],
        outsourcingTerms: [],
        negativeTerms: [],
      },
      minimumScore: 95,
    });

    expect(result.score).toBe(40);
    expect(result.grade).toBe("REJECT");
    expect(result.qualified).toBe(false);
    expect(result.recommendedAction).toBe("URGENT_BDE_REVIEW");
    expect(result.highIntentOverride).toMatchObject({
      applied: true,
      signal: "MATCHING_RFP",
    });
  });

  it("never qualifies a reject-grade lead even when the campaign threshold is zero", () => {
    const input = scoringInput();
    const result = scoreOpportunity({
      ...input,
      claims: [
        {
          id: ids.claimCapability,
          type: "COMPANY_FACT",
          statement: "Acme has a source-backed company profile.",
          evidenceIds: [ids.sourceCapability],
        },
      ],
      criteria: {
        sectorTerms: [],
        capabilityTerms: [],
        targetClientTerms: [],
        outsourcingTerms: [],
        negativeTerms: [],
      },
      minimumScore: 0,
    });

    expect(result).toMatchObject({
      score: 0,
      grade: "REJECT",
      qualified: false,
      recommendedAction: "REJECT",
    });
  });

  it("links a high-intent claim to capability evidence from the same source", () => {
    const input = scoringInput();
    const result = scoreOpportunity({
      ...input,
      claims: [
        {
          id: ids.claimProcurement,
          type: "RFP",
          statement: "Acme issued an RFP for production support.",
          evidenceIds: [ids.sourceProcurement],
        },
        {
          id: ids.claimCapability,
          type: "CAPABILITY",
          statement: "The requested production support includes LiDAR processing.",
          evidenceIds: [ids.sourceProcurement],
        },
      ],
    });

    expect(result.highIntentOverride).toEqual({
      applied: true,
      signal: "MATCHING_RFP",
      evidenceIds: [ids.sourceProcurement],
    });
  });

  it.each([
    ["RFP", 100],
    ["RFQ", 100],
    ["TENDER", 100],
    ["VENDOR_SEARCH", 100],
    ["SUBCONTRACTOR_SEARCH", 100],
    ["PROJECT_AWARD", 85],
    ["FUNDING", 65],
    ["EXPANSION", 65],
    ["HIRING", 45],
    ["LEADERSHIP_CHANGE", 35],
    ["TECHNOLOGY_TRANSFORMATION", 75],
    ["NEW_PRODUCT", 55],
    ["PARTNERSHIP", 50],
    ["ACQUISITION", 70],
    ["CAPACITY_CONSTRAINT", 80],
  ] as const)("scores the planned %s buying signal", (type, expectedScore) => {
    const result = scoreOpportunity({
      ...scoringInput(),
      claims: [
        {
          id: ids.claimProject,
          type,
          statement: "Acme has a source-backed business signal.",
          evidenceIds: [ids.sourceProject],
        },
      ],
      criteria: {
        sectorTerms: [],
        capabilityTerms: [],
        targetClientTerms: [],
        outsourcingTerms: [],
        negativeTerms: [],
      },
      weights: {
        sectorFit: 0,
        capabilityMatch: 0,
        targetClientFit: 0,
        outsourcingProbability: 0,
        buyingIntent: 100,
        businessMomentum: 0,
        decisionMakerQuality: 0,
        contactConfidence: 0,
      },
    });

    expect(result.score).toBe(expectedScore);
    expect(result.intentScore).toBe(expectedScore);
  });
});
