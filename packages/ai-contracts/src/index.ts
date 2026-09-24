import { z } from "zod";

export const SearchStrategyTypeSchema = z.enum([
  "DIRECT_COMPANY",
  "PROJECT_AWARD",
  "OUTSOURCING",
  "RFP_VENDOR",
]);

export const SearchStrategySchema = z.object({
  type: SearchStrategyTypeSchema,
  queries: z.array(z.string().trim().min(3).max(500)).min(1).max(3),
});

export const SearchPlanSchema = z.object({
  strategies: z.array(SearchStrategySchema).min(1).max(4),
});

export const SearchResultSchema = z.object({
  organizationName: z.string().trim().min(1).max(240),
  organizationLocation: z.string().trim().min(1).max(320).nullable(),
  websiteUrl: z.string().trim().min(1).max(2_048).nullable(),
  sourceUrl: z.string().trim().min(1).max(2_048),
  sourceTitle: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(2_000),
  evidenceSnippet: z.string().trim().min(1).max(1_000),
  strategyType: SearchStrategyTypeSchema,
  query: z.string().trim().min(3).max(500),
});

export const SearchResultsSchema = z.object({
  results: z.array(SearchResultSchema).max(25),
});

export type SearchPlan = z.infer<typeof SearchPlanSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type SearchStrategyType = z.infer<typeof SearchStrategyTypeSchema>;
