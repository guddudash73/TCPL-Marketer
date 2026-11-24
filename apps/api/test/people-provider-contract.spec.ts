import {
  type PeopleProvider,
  type PeopleSearchInput,
} from "@tcpl-marketer/provider-contracts";
import {
  PeopleSearchInputSchema,
  PersonCandidateSchema,
  normalizePersonCandidate,
} from "@tcpl-marketer/validation";
import { describe, expect, it, vi } from "vitest";
import { testCall } from "./support/provider-call.js";

describe("PeopleProvider contract", () => {
  it("returns a normalized provider-independent person candidate", async () => {
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
    const searchPeople = vi.fn().mockResolvedValue({ candidates: [candidate], usage: { requests: 1, credits: 0 } });
    const provider: PeopleProvider = {
      searchPeople,
      enrichPerson: vi.fn().mockResolvedValue(null),
    };
    const input: PeopleSearchInput = PeopleSearchInputSchema.parse({
      organization: {
        id: "f8ac41f5-f901-4544-9c1d-46c416aab710",
        name: "Example Surveying",
        domain: "example.test",
        location: "Colorado",
      },
      roles: [
        {
          decisionMakerProfileId: "d88a7fc7-f835-4d8b-8de3-74745493885b",
          title: "Survey Director",
          priority: 1,
          seniorities: ["Director"],
          positiveTerms: ["survey"],
          negativeTerms: [],
        },
      ],
      maximumResults: 10,
    });

    const run = await provider.searchPeople(input, testCall("apollo", "people-search"));
    expect(run.usage).toEqual({ requests: 1, credits: 0 });
    const result = run.candidates;

    expect(result[0]).toMatchObject({
      fullName: "Jordan   Smith",
      normalizedName: "jordan smith",
      source: { provider: "company-research", externalId: null },
      role: {
        title: "Director   of Surveying",
        normalizedTitle: "director of surveying",
      },
    });
    expect(PersonCandidateSchema.parse(result[0])).toEqual(result[0]);
    expect(
      PersonCandidateSchema.safeParse({
        ...result[0],
        apolloPerson: { id: "apollo-specific" },
      }).success,
    ).toBe(false);
    expect(searchPeople).toHaveBeenCalledWith(input, expect.anything());
  });
});
