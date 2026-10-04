import { ClaimTypeSchema } from "@tcpl-marketer/ai-contracts";
import { z } from "zod";

const boundedUrl = z.string().url().max(2_048);
const normalizedText = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => value === normalizePersonText(value), {
      message: "Value must be lowercase with collapsed whitespace",
    });

export const PersonSourceTypeSchema = z.enum([
  "COMPANY_WEBSITE",
  "PUBLIC_WEB",
  "PROVIDER",
]);

export const PersonSourceSchema = z.strictObject({
  type: PersonSourceTypeSchema,
  provider: z.string().trim().min(1).max(64),
  externalId: z.string().trim().min(1).max(255).nullable().default(null),
  url: boundedUrl.nullable().default(null),
});

export const PersonRoleCandidateInputSchema = z.strictObject({
  title: z.string().trim().min(1).max(240),
  seniority: z.string().trim().min(1).max(80).nullable().default(null),
  departments: z
    .array(z.string().trim().min(1).max(120))
    .max(20)
    .default([]),
  isCurrent: z.boolean().default(true),
  sourceUrl: boundedUrl.nullable().default(null),
  confidence: z.number().finite().min(0).max(1),
});

export const NormalizedPersonRoleSchema =
  PersonRoleCandidateInputSchema.extend({
    normalizedTitle: normalizedText(240),
  });

export const PersonCandidateInputSchema = z.strictObject({
  fullName: z.string().trim().min(1).max(240),
  location: z.string().trim().min(1).max(320).nullable().default(null),
  profileUrl: boundedUrl.nullable().default(null),
  source: PersonSourceSchema,
  confidence: z.number().finite().min(0).max(1),
  role: PersonRoleCandidateInputSchema,
});

export const PersonCandidateSchema = PersonCandidateInputSchema.extend({
  normalizedName: normalizedText(240),
  role: NormalizedPersonRoleSchema,
});

export const PersonSearchRoleSchema = z.strictObject({
  decisionMakerProfileId: z.uuid(),
  title: z.string().trim().min(1).max(160),
  priority: z.number().int().positive(),
  seniorities: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  positiveTerms: z.array(z.string().trim().min(1).max(160)).max(100).default([]),
  negativeTerms: z.array(z.string().trim().min(1).max(160)).max(100).default([]),
});

export const PeopleSearchInputSchema = z.strictObject({
  organization: z.strictObject({
    id: z.uuid(),
    name: z.string().trim().min(1).max(240),
    domain: z.string().trim().toLowerCase().max(255).nullable().default(null),
    location: z.string().trim().min(1).max(320).nullable().default(null),
  }),
  roles: z.array(PersonSearchRoleSchema).min(1).max(50),
  maximumResults: z.number().int().min(1).max(100).default(25),
});

export function normalizePersonText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function normalizePersonCandidate(
  input: PersonCandidateInput,
): PersonCandidate {
  const parsed = PersonCandidateInputSchema.parse(input);
  return PersonCandidateSchema.parse({
    ...parsed,
    normalizedName: normalizePersonText(parsed.fullName),
    role: {
      ...parsed.role,
      normalizedTitle: normalizePersonText(parsed.role.title),
    },
  });
}

export const OpportunityScoreComponentKeySchema = z.enum([
  "sectorFit",
  "capabilityMatch",
  "targetClientFit",
  "outsourcingProbability",
  "buyingIntent",
  "businessMomentum",
  "decisionMakerQuality",
  "contactConfidence",
]);

const percentage = z.number().finite().min(0).max(100);
const confidence = z.number().finite().min(0).max(1);
const scoreWeightsShape = {
  sectorFit: percentage,
  capabilityMatch: percentage,
  targetClientFit: percentage,
  outsourcingProbability: percentage,
  buyingIntent: percentage,
  businessMomentum: percentage,
  decisionMakerQuality: percentage,
  contactConfidence: percentage,
};

export const OpportunityScoreWeightsSchema = z
  .strictObject(scoreWeightsShape)
  .refine(
    (weights) =>
      Math.abs(
        Object.values(weights).reduce((total, weight) => total + weight, 0) -
          100,
      ) < 1e-9,
    { message: "Opportunity score weights must total 100" },
  );

export const DEFAULT_OPPORTUNITY_SCORE_WEIGHTS = Object.freeze({
  sectorFit: 15,
  capabilityMatch: 20,
  targetClientFit: 15,
  outsourcingProbability: 15,
  buyingIntent: 20,
  businessMomentum: 5,
  decisionMakerQuality: 5,
  contactConfidence: 5,
}) satisfies z.input<typeof OpportunityScoreWeightsSchema>;

export const ScoringClaimTypeSchema = ClaimTypeSchema;

export const EvidenceBackedScoringClaimSchema = z.strictObject({
  id: z.uuid(),
  type: ScoringClaimTypeSchema,
  statement: z.string().trim().min(1).max(2_000),
  evidenceIds: z.array(z.uuid()).min(1).max(10),
});

const configuredTerms = z
  .array(z.string().trim().min(1).max(160))
  .max(100)
  .default([]);
const explanation = z.string().trim().min(1).max(500);

export const DownstreamScoreFactorSchema = z.strictObject({
  score: percentage,
  confidence,
  reasons: z.array(explanation).min(1).max(20),
  evidenceIds: z.array(z.uuid()).max(50).default([]),
});

export const OpportunityScoringInputSchema = z.strictObject({
  organizationId: z.uuid(),
  claims: z.array(EvidenceBackedScoringClaimSchema).min(1).max(100),
  criteria: z.strictObject({
    sectorTerms: configuredTerms,
    capabilityTerms: configuredTerms,
    targetClientTerms: configuredTerms,
    outsourcingTerms: configuredTerms,
    negativeTerms: configuredTerms,
  }),
  downstream: z
    .strictObject({
      decisionMakerQuality: DownstreamScoreFactorSchema.optional(),
      contactConfidence: DownstreamScoreFactorSchema.optional(),
    })
    .default({}),
  weights: OpportunityScoreWeightsSchema.default(
    DEFAULT_OPPORTUNITY_SCORE_WEIGHTS,
  ),
  minimumScore: z.number().int().min(0).max(100).default(60),
});

export const HighIntentSignalSchema = z.enum([
  "MATCHING_RFP",
  "MATCHING_RFQ",
  "TENDER",
  "DIRECT_VENDOR_SEARCH",
  "DIRECT_OUTSOURCING_REQUEST",
  "SUBCONTRACTOR_SEARCH",
]);

export const OpportunityScoreComponentSchema = z.strictObject({
  key: OpportunityScoreComponentKeySchema,
  rawScore: z.number().int().min(0).max(100),
  confidence,
  weight: percentage,
  weightedContribution: percentage,
  reasons: z.array(explanation).min(1).max(20),
  evidenceIds: z.array(z.uuid()).max(100),
});

export const LeadGradeSchema = z.enum([
  "A_PLUS_URGENT",
  "A",
  "B",
  "C_REVIEW",
  "REJECT",
]);

export const ScoringRecommendedActionSchema = z.enum([
  "URGENT_BDE_REVIEW",
  "STANDARD_REVIEW",
  "REJECT",
]);

export const HighIntentOverrideSchema = z.discriminatedUnion("applied", [
  z.strictObject({
    applied: z.literal(false),
    signal: z.null(),
    evidenceIds: z.array(z.uuid()).length(0),
  }),
  z.strictObject({
    applied: z.literal(true),
    signal: HighIntentSignalSchema,
    evidenceIds: z.array(z.uuid()).min(1).max(100),
  }),
]);

export const OpportunityScoreResultSchema = z.strictObject({
  organizationId: z.uuid(),
  score: z.number().int().min(0).max(100),
  needScore: z.number().int().min(0).max(100),
  intentScore: z.number().int().min(0).max(100),
  grade: LeadGradeSchema,
  qualified: z.boolean(),
  recommendedAction: ScoringRecommendedActionSchema,
  minimumScore: z.number().int().min(0).max(100),
  components: z
    .array(OpportunityScoreComponentSchema)
    .length(OpportunityScoreComponentKeySchema.options.length),
  reasons: z.array(explanation).min(1).max(100),
  evidenceIds: z.array(z.uuid()).max(100),
  highIntentOverride: HighIntentOverrideSchema,
});

export type OpportunityScoreComponentKey = z.infer<
  typeof OpportunityScoreComponentKeySchema
>;
export type OpportunityScoreWeights = z.infer<
  typeof OpportunityScoreWeightsSchema
>;
export type EvidenceBackedScoringClaim = z.infer<
  typeof EvidenceBackedScoringClaimSchema
>;
export type OpportunityScoringInput = z.input<
  typeof OpportunityScoringInputSchema
>;
export type ParsedOpportunityScoringInput = z.output<
  typeof OpportunityScoringInputSchema
>;
export type HighIntentSignal = z.infer<typeof HighIntentSignalSchema>;
export type OpportunityScoreComponent = z.infer<
  typeof OpportunityScoreComponentSchema
>;
export type LeadGrade = z.infer<typeof LeadGradeSchema>;
export type ScoringRecommendedAction = z.infer<
  typeof ScoringRecommendedActionSchema
>;
export type OpportunityScoreResult = z.infer<
  typeof OpportunityScoreResultSchema
>;
export type PersonSourceType = z.infer<typeof PersonSourceTypeSchema>;
export type PersonSource = z.infer<typeof PersonSourceSchema>;
export type PersonRoleCandidateInput = z.input<
  typeof PersonRoleCandidateInputSchema
>;
export type NormalizedPersonRole = z.infer<typeof NormalizedPersonRoleSchema>;
export type PersonCandidateInput = z.input<typeof PersonCandidateInputSchema>;
export type PersonCandidate = z.infer<typeof PersonCandidateSchema>;
export type PersonSearchRole = z.infer<typeof PersonSearchRoleSchema>;
export type PeopleSearchInput = z.infer<typeof PeopleSearchInputSchema>;
