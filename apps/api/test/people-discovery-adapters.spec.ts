import type { PeopleSearchInput } from "@tcpl-marketer/provider-contracts";
import { PeopleSearchInputSchema, PersonCandidateSchema } from "@tcpl-marketer/validation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApolloPeopleSearchAdapter } from "../src/people/apollo-people-search.adapter.js";
import { PublicPeopleSearchAdapter } from "../src/people/public-people-search.adapter.js";

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
      seniorities: ["Director", "Vice President", "unsupported"],
      positiveTerms: ["survey"],
      negativeTerms: [],
    },
  ],
  maximumResults: 2,
});

describe("people discovery adapters", () => {
  const originalApolloKey = process.env.APOLLO_API_KEY;
  const originalOpenAIKey = process.env.OPENAI_API_KEY;
  const originalOpenAIModel = process.env.OPENAI_RESEARCH_MODEL;

  beforeEach(() => {
    process.env.APOLLO_API_KEY = "apollo-test-key";
    process.env.OPENAI_API_KEY = "openai-test-key";
    process.env.OPENAI_RESEARCH_MODEL = "test-research-model";
  });

  afterEach(() => {
    restore("APOLLO_API_KEY", originalApolloKey);
    restore("OPENAI_API_KEY", originalOpenAIKey);
    restore("OPENAI_RESEARCH_MODEL", originalOpenAIModel);
    vi.restoreAllMocks();
  });

  it("normalizes public results and retains only consulted evidence URLs", async () => {
    const parse = vi.fn().mockResolvedValue({
      output_parsed: {
        people: [
          {
            fullName: "  Jordan Smith ",
            title: " Director of Surveying ",
            seniority: "Director",
            departments: ["Surveying"],
            location: "Denver, Colorado",
            profileUrl: "https://example.test/team/jordan-smith",
            sourceUrl: "https://example.test/team",
            confidence: 0.94,
          },
          {
            fullName: "Unsupported Person",
            title: "Survey Director",
            seniority: null,
            departments: [],
            location: null,
            profileUrl: null,
            sourceUrl: "https://unconsulted.test/person",
            confidence: 0.5,
          },
        ],
      },
      output: [
        {
          type: "web_search_call",
          action: { sources: [{ url: "https://example.test/team" }] },
        },
      ],
    });
    const adapter = new PublicPeopleSearchAdapter({
      responses: { parse },
    } as never);

    const result = await adapter.searchPeople(input);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      fullName: "Jordan Smith",
      normalizedName: "jordan smith",
      source: {
        type: "COMPANY_WEBSITE",
        provider: "openai-public-web",
        externalId: null,
      },
      role: {
        title: "Director of Surveying",
        normalizedTitle: "director of surveying",
      },
    });
    expect(PersonCandidateSchema.parse(result[0])).toEqual(result[0]);
    expect(parse).toHaveBeenCalledWith(
      expect.objectContaining({
        tool_choice: "required",
        include: ["web_search_call.action.sources"],
      }),
    );
  });

  it("uses only Apollo People Search filters and strips contact data", async () => {
    let requestBody: Record<string, unknown> = {};
    const request = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          people: [
            {
              id: "apollo-person-1",
              first_name: "Jordan",
              last_name: "Smith",
              title: "VP of Surveying",
              seniority: "vp",
              departments: ["operations"],
              linkedin_url: "https://www.linkedin.com/in/jordan-smith",
              city: "Denver",
              state: "Colorado",
              country: "United States",
              email: "must-not-cross-boundary@example.test",
              mobile_phone: "+1-555-0100",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const adapter = new ApolloPeopleSearchAdapter(request as typeof fetch);

    const result = await adapter.searchPeople(input);

    expect(request).toHaveBeenCalledOnce();
    expect(String(request.mock.calls[0]?.[0])).toBe(
      "https://api.apollo.io/api/v1/mixed_people/api_search",
    );
    expect(requestBody).toEqual({
      q_organization_domains_list: ["example.test"],
      person_titles: ["Survey Director"],
      person_seniorities: ["director", "vp"],
      include_similar_titles: true,
      page: 1,
      per_page: 2,
    });
    expect(JSON.stringify(requestBody)).not.toMatch(/email|phone|mobile/i);
    expect(result[0]).toMatchObject({
      fullName: "Jordan Smith",
      source: {
        type: "PROVIDER",
        provider: "apollo",
        externalId: "apollo-person-1",
      },
      role: { title: "VP of Surveying", seniority: "vp" },
    });
    expect(result[0]).not.toHaveProperty("email");
    expect(result[0]).not.toHaveProperty("mobilePhone");
    expect(PersonCandidateSchema.parse(result[0])).toEqual(result[0]);
  });
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
