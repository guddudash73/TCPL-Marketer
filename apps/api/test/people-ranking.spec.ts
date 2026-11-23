import { describe, expect, it } from "vitest";

import {
  rankDecisionMakers,
  type DecisionMakerCandidateInput,
  type DecisionMakerProfileInput,
} from "../src/people/decision-maker-ranking.service.js";

const profiles: DecisionMakerProfileInput[] = [
  {
    id: "production-profile",
    capabilityName: "LiDAR processing",
    title: "LiDAR Production Manager",
    priority: 1,
    seniorities: ["manager"],
    positiveTerms: ["production", "lidar"],
    negativeTerms: ["sales"],
  },
  {
    id: "operations-profile",
    capabilityName: "LiDAR processing",
    title: "Survey Operations Director",
    priority: 2,
    seniorities: ["director"],
    positiveTerms: ["survey", "operations"],
    negativeTerms: [],
  },
  {
    id: "coo-profile",
    capabilityName: "LiDAR processing",
    title: "COO",
    priority: 5,
    seniorities: ["c_suite"],
    positiveTerms: [],
    negativeTerms: [],
  },
];

describe("decision-maker ranking", () => {
  it("deterministically ranks current candidates against configured roles", () => {
    const result = rankDecisionMakers(
      [
        candidate("person-1", "role-1", "Avery Adams", "LiDAR Production Manager", "manager", 0.96),
        candidate("person-2", "role-2", "Bailey Brooks", "Survey Operations Director", "director", 0.9),
        candidate("person-3", "role-3", "Casey Cole", "COO", "c-suite", 0.84),
        { ...candidate("person-4", "role-4", "Former Person", "LiDAR Production Manager", "manager", 1), isCurrent: false },
      ],
      profiles,
    );

    expect(result.map(({ personId }) => personId)).toEqual([
      "person-1",
      "person-2",
      "person-3",
    ]);
    expect(result[0]).toMatchObject({
      decisionMakerProfileId: "production-profile",
      score: 67,
      components: {
        capabilityRelevance: 35,
        departmentOwnership: 0,
        authority: 12,
        seniority: 10,
        companySizeFit: 0,
        currentRoleConfidence: 5,
        sourceConfidence: 5,
      },
    });
    expect(result[0]?.reasons).toContain(
      "Exact configured role match: LiDAR Production Manager",
    );
  });

  it("keeps the best role per person and penalizes configured negative terms", () => {
    const clean = candidate(
      "person-1",
      "role-1",
      "Avery Adams",
      "LiDAR Production Manager",
      "manager",
      0.8,
    );
    const sales = {
      ...candidate(
        "person-2",
        "role-2",
        "Bailey Brooks",
        "LiDAR Production Sales Manager",
        "manager",
        0.99,
      ),
      departments: ["sales"],
    };
    const duplicatePersonRole = candidate(
      "person-1",
      "role-3",
      "Avery Adams",
      "Operations Manager",
      "manager",
      0.4,
    );

    const result = rankDecisionMakers([sales, duplicatePersonRole, clean], profiles);

    expect(result.filter(({ personId }) => personId === "person-1")).toHaveLength(1);
    expect(result[0]?.personId).toBe("person-1");
    expect(result.find(({ personId }) => personId === "person-2")?.reasons).toContain(
      "Negative role terms: sales",
    );
  });
});

function candidate(
  personId: string,
  personRoleId: string,
  fullName: string,
  title: string,
  seniority: string,
  confidence: number,
): DecisionMakerCandidateInput {
  return {
    personId,
    personRoleId,
    fullName,
    normalizedName: fullName.toLocaleLowerCase("en-US"),
    personConfidence: confidence,
    title,
    normalizedTitle: title.toLocaleLowerCase("en-US"),
    seniority,
    departments: [],
    roleConfidence: confidence,
    isCurrent: true,
    reviewUrl: `https://example.test/people/${personId}`,
  };
}
