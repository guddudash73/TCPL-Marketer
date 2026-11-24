import type {
  ClaimExtraction,
  SearchPlan,
  SearchResult,
} from "@tcpl-marketer/ai-contracts";
import type {
  PeopleSearchInput,
  PersonCandidate,
} from "@tcpl-marketer/validation";

export type {
  PeopleSearchInput,
  PersonCandidate,
} from "@tcpl-marketer/validation";

export const CLAIM_EXTRACTOR = Symbol("CLAIM_EXTRACTOR");
export const PEOPLE_PROVIDER = Symbol("PEOPLE_PROVIDER");
export const SEARCH_PLANNER = Symbol("SEARCH_PLANNER");
export const SEARCH_PROVIDER = Symbol("SEARCH_PROVIDER");

/**
 * Issued by the provider gateway for exactly one provider call (PH1-03c). Every
 * provider adapter requires it, so an adapter cannot be called outside the
 * gateway that reserves budget, applies the rate limit and writes the audit row.
 */
export interface ProviderCallContext {
  readonly provider: string;
  readonly operation: string;
  /** Counts one outbound provider request toward the call's reported usage. */
  recordRequest(count?: number): void;
}

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
    context: ProviderCallContext,
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
  /** Billed web_search tool calls in the response. Absent when the provider did not report it. */
  webSearchCalls?: number;
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
  plan(input: SearchCampaignContext, context: ProviderCallContext): Promise<ProviderRun<SearchPlan>>;
}

export interface SearchProvider {
  search(input: SearchRequest, context: ProviderCallContext): Promise<ProviderRun<SearchResult[]>>;
}

export interface PersonEnrichmentInput {
  personId: string;
  fullName: string;
  organizationName: string;
  organizationDomain: string | null;
  providerPersonId: string | null;
}

export interface EnrichedPerson {
  personId: string;
  provider: string;
  providerPersonId: string;
  businessEmail: string | null;
  matchConfidence: number | null;
  providerResponseReference: string | null;
  enrichedAt: string;
}

/** What one people search consumed. A field is absent when the provider did not report it. */
export interface PeopleSearchUsage {
  requests: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** Billed web searches (OpenAI web_search `search` actions). */
  webSearchCalls?: number;
  /** Provider credits consumed, as the provider documents them. */
  credits?: number;
}

export interface PeopleSearchRun {
  candidates: PersonCandidate[];
  usage: PeopleSearchUsage | null;
}

export interface PeopleProvider {
  searchPeople(input: PeopleSearchInput, context: ProviderCallContext): Promise<PeopleSearchRun>;
  enrichPerson(input: PersonEnrichmentInput): Promise<EnrichedPerson | null>;
}
