import type {
  ClaimExtraction,
  SearchPlan,
  SearchResult,
} from "@tcpl-marketer/ai-contracts";

export const CLAIM_EXTRACTOR = Symbol("CLAIM_EXTRACTOR");
export const SEARCH_PLANNER = Symbol("SEARCH_PLANNER");
export const SEARCH_PROVIDER = Symbol("SEARCH_PROVIDER");

export interface ClaimSourceDocument {
  evidenceId: string;
  url: string;
  title: string | null;
  text: string;
}

export interface ClaimExtractionRequest {
  organizationId: string;
  organizationName: string;
  documents: ClaimSourceDocument[];
}

export interface ClaimExtractorConfiguration {
  provider: string;
  model: string;
  prompt: { name: string; version: string };
}

export interface ClaimExtractor {
  getConfiguration(): ClaimExtractorConfiguration;
  extract(
    input: ClaimExtractionRequest,
  ): Promise<ProviderRun<ClaimExtraction>>;
}

export interface SearchCampaignContext {
  campaignId: string;
  sector: {
    name: string;
    description: string | null;
    terminology: string[];
    negativeTerms: string[];
  };
  capabilities: Array<{
    name: string;
    description: string | null;
    businessProblems: string[];
    businessValue: string | null;
    searchGuidance: Record<string, unknown> | null;
  }>;
  deliverables: Array<{ name: string; description: string | null }>;
  targetProfiles: Array<{
    name: string;
    companyCharacteristics: Record<string, unknown> | null;
    positiveTerms: string[];
    negativeTerms: string[];
    typicalBusinessModel: string | null;
    outsourcingCharacteristics: string | null;
  }>;
  geography: { countries: string[]; states: string[]; cities: string[] };
  employeeRange: { minimum: number | null; maximum: number | null };
  targetLeadCount: number;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface ProviderRun<T> {
  data: T;
  model: string;
  providerResponseId: string;
  prompt: { name: string; version: string };
  usage: ProviderUsage | null;
}

export interface SearchRequest {
  context: SearchCampaignContext;
  plan: SearchPlan;
  maximumResults: number;
}

export interface SearchPlanner {
  plan(input: SearchCampaignContext): Promise<ProviderRun<SearchPlan>>;
}

export interface SearchProvider {
  search(input: SearchRequest): Promise<ProviderRun<SearchResult[]>>;
}
