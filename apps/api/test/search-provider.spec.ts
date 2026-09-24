import type { SearchCampaignContext } from "@tcpl-marketer/provider-contracts";
import type OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OpenAISearchAdapter } from "../src/search/openai-search.adapter.js";

const context: SearchCampaignContext = {
  campaignId: "campaign-1",
  sector: {
    name: "LiDAR",
    description: "Geospatial services",
    terminology: ["LiDAR"],
    negativeTerms: [],
  },
  capabilities: [
    {
      name: "Point-cloud processing",
      description: null,
      businessProblems: ["processing backlog"],
      businessValue: "Delivery capacity",
      searchGuidance: null,
    },
  ],
  deliverables: [{ name: "Classified point cloud", description: null }],
  targetProfiles: [
    {
      name: "Surveying firms",
      companyCharacteristics: null,
      positiveTerms: ["surveying"],
      negativeTerms: [],
      typicalBusinessModel: null,
      outsourcingCharacteristics: null,
    },
  ],
  geography: { countries: ["United States"], states: [], cities: [] },
  employeeRange: { minimum: 10, maximum: 500 },
  targetLeadCount: 5,
};

describe("OpenAISearchAdapter provider contract", () => {
  const originalKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_RESEARCH_MODEL;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.OPENAI_RESEARCH_MODEL = "test-search-model";
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalKey;
    if (originalModel === undefined) delete process.env.OPENAI_RESEARCH_MODEL;
    else process.env.OPENAI_RESEARCH_MODEL = originalModel;
  });

  it("returns a structured plan and source-grounded discovery results", async () => {
    const parse = vi
      .fn()
      .mockResolvedValueOnce({
        id: "resp-plan",
        model: "test-search-model",
        output: [],
        output_parsed: {
          strategies: [
            {
              type: "DIRECT_COMPANY",
              queries: ["US LiDAR surveying companies"],
            },
          ],
        },
        usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
      })
      .mockResolvedValueOnce({
        id: "resp-search",
        model: "test-search-model",
        output: [
          {
            type: "web_search_call",
            action: {
              type: "search",
              sources: [{ type: "url", url: "https://example.com/company?a=1" }],
            },
          },
        ],
        output_parsed: {
          results: [
            {
              organizationName: "Example Surveying",
              organizationLocation: "United States",
              websiteUrl: "https://example.com",
              sourceUrl: "https://example.com/company",
              sourceTitle: "Example Surveying Company",
              summary: "A US surveying firm with LiDAR services.",
              evidenceSnippet: "Provides LiDAR surveying services.",
              strategyType: "DIRECT_COMPANY",
              query: "US LiDAR surveying companies",
            },
          ],
        },
        usage: { input_tokens: 200, output_tokens: 75, total_tokens: 275 },
      });
    const client = { responses: { parse } } as unknown as OpenAI;
    const adapter = new OpenAISearchAdapter(client);

    const planning = await adapter.plan(context);
    const discovery = await adapter.search({
      context,
      plan: planning.data,
      maximumResults: 5,
    });

    expect(planning.data.strategies).toHaveLength(1);
    expect(planning.prompt).toEqual({
      name: "campaign-search-plan",
      version: "v1",
    });
    expect(discovery.data).toHaveLength(1);
    expect(discovery.usage?.totalTokens).toBe(275);
    expect(parse.mock.calls[1]?.[0]).toMatchObject({
      model: "test-search-model",
      store: false,
      tools: [{ type: "web_search", external_web_access: true }],
      tool_choice: "required",
    });
  });

  it("rejects model output that is not grounded in consulted sources", async () => {
    const parse = vi.fn().mockResolvedValue({
      id: "resp-search",
      model: "test-search-model",
      output: [],
      output_parsed: {
        results: [
          {
            organizationName: "Unsupported Company",
            organizationLocation: null,
            websiteUrl: null,
            sourceUrl: "https://unsupported.example/company",
            sourceTitle: "Unsupported",
            summary: "Unsupported result.",
            evidenceSnippet: "Unsupported evidence.",
            strategyType: "DIRECT_COMPANY",
            query: "US LiDAR surveying companies",
          },
        ],
      },
    });
    const adapter = new OpenAISearchAdapter({
      responses: { parse },
    } as unknown as OpenAI);

    await expect(
      adapter.search({
        context,
        plan: {
          strategies: [
            {
              type: "DIRECT_COMPANY",
              queries: ["US LiDAR surveying companies"],
            },
          ],
        },
        maximumResults: 5,
      }),
    ).rejects.toThrow("no results grounded in consulted sources");
  });
});
