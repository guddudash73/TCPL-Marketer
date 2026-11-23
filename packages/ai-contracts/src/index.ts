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

export const ClaimTypeSchema = z.enum([
  "COMPANY_FACT",
  "CAPABILITY",
  "PROJECT",
  "PROJECT_AWARD",
  "CUSTOMER",
  "CERTIFICATION",
  "HIRING",
  "FUNDING",
  "EXPANSION",
  "LEADERSHIP",
  "LEADERSHIP_CHANGE",
  "PROCUREMENT",
  "RFP",
  "RFQ",
  "TENDER",
  "VENDOR_SEARCH",
  "SUBCONTRACTOR_SEARCH",
  "TECHNOLOGY_TRANSFORMATION",
  "NEW_PRODUCT",
  "PARTNERSHIP",
  "ACQUISITION",
  "CAPACITY_CONSTRAINT",
  "OTHER",
]);

export const ExtractedClaimSchema = z.object({
  statement: z.string().trim().min(1).max(2_000),
  type: ClaimTypeSchema,
  evidenceIds: z.array(z.string().trim().min(1).max(100)).min(1).max(10),
});

const companyFitEvidenceShape = {
  sourceId: z.string().trim().min(1).max(100),
  evidenceExcerpt: z.string().trim().min(1).max(1_000),
  confidence: z.number().finite().min(0).max(1),
  conflictsWithSourceIds: z
    .array(z.string().trim().min(1).max(100))
    .max(10),
};

export const ExtractedHeadcountObservationSchema = z
  .object({
    factType: z.literal("HEADCOUNT"),
    minimum: z.number().int().min(0).max(10_000_000),
    maximum: z.number().int().min(0).max(10_000_000),
    ...companyFitEvidenceShape,
  })
  .refine(({ minimum, maximum }) => minimum <= maximum, {
    message: "Headcount minimum must not exceed maximum",
    path: ["maximum"],
  });

export const ExtractedGeographyObservationSchema = z.object({
  factType: z.literal("GEOGRAPHY"),
  value: z.string().trim().min(1).max(320),
  ...companyFitEvidenceShape,
});

export const ExtractedBusinessModelObservationSchema = z.object({
  factType: z.literal("BUSINESS_MODEL"),
  value: z.string().trim().min(1).max(500),
  ...companyFitEvidenceShape,
});

export const ExtractedCompanyFitObservationSchema = z.union([
  ExtractedHeadcountObservationSchema,
  ExtractedGeographyObservationSchema,
  ExtractedBusinessModelObservationSchema,
]);

export const ClaimExtractionSchema = z.object({
  claims: z.array(ExtractedClaimSchema).max(50),
  companyFitObservations: z.array(ExtractedCompanyFitObservationSchema).max(50),
});

export type ClaimExtraction = z.infer<typeof ClaimExtractionSchema>;
export type ExtractedClaim = z.infer<typeof ExtractedClaimSchema>;
export type ClaimType = z.infer<typeof ClaimTypeSchema>;
export type ExtractedCompanyFitObservation = z.infer<
  typeof ExtractedCompanyFitObservationSchema
>;
