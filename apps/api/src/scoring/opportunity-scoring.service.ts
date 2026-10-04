import {
  OpportunityScoreResultSchema,
  OpportunityScoringInputSchema,
  type EvidenceBackedScoringClaim,
  type HighIntentSignal,
  type LeadGrade,
  type OpportunityScoreComponent,
  type OpportunityScoreComponentKey,
  type OpportunityScoreResult,
  type OpportunityScoreWeights,
  type OpportunityScoringInput,
  type ParsedOpportunityScoringInput,
  type ScoringRecommendedAction,
} from "@tcpl-marketer/validation";

interface Evaluation {
  rawScore: number;
  confidence: number;
  reasons: string[];
  evidenceIds: string[];
}

interface HighIntentMatch {
  signal: HighIntentSignal;
  evidenceIds: string[];
}

const HIGH_INTENT_RULES: ReadonlyArray<{
  signal: HighIntentSignal;
  types: readonly EvidenceBackedScoringClaim["type"][];
  terms: readonly string[];
}> = [
  {
    signal: "MATCHING_RFP",
    types: ["RFP"],
    terms: ["rfp", "request for proposal"],
  },
  {
    signal: "MATCHING_RFQ",
    types: ["RFQ"],
    terms: ["rfq", "request for quotation"],
  },
  { signal: "TENDER", types: ["TENDER"], terms: ["tender"] },
  {
    signal: "DIRECT_VENDOR_SEARCH",
    types: ["VENDOR_SEARCH"],
    terms: ["vendor search", "seeking vendor"],
  },
  {
    signal: "DIRECT_OUTSOURCING_REQUEST",
    types: [],
    terms: ["outsourcing request", "seeking outsourcing partner"],
  },
  {
    signal: "SUBCONTRACTOR_SEARCH",
    types: ["SUBCONTRACTOR_SEARCH"],
    terms: ["subcontractor search", "seeking subcontractor"],
  },
];

const BUYING_SIGNAL_SCORES: Readonly<
  Partial<Record<EvidenceBackedScoringClaim["type"], number>>
> = {
  RFP: 100,
  RFQ: 100,
  TENDER: 100,
  VENDOR_SEARCH: 100,
  SUBCONTRACTOR_SEARCH: 100,
  PROCUREMENT: 90,
  PROJECT_AWARD: 85,
  PROJECT: 70,
  CAPACITY_CONSTRAINT: 80,
  TECHNOLOGY_TRANSFORMATION: 75,
  ACQUISITION: 70,
  FUNDING: 65,
  EXPANSION: 65,
  NEW_PRODUCT: 55,
  PARTNERSHIP: 50,
  HIRING: 45,
  LEADERSHIP_CHANGE: 35,
  LEADERSHIP: 35,
};

const MOMENTUM_SCORES: Readonly<
  Partial<Record<EvidenceBackedScoringClaim["type"], number>>
> = {
  FUNDING: 90,
  PROJECT_AWARD: 85,
  PROJECT: 80,
  EXPANSION: 80,
  ACQUISITION: 75,
  NEW_PRODUCT: 70,
  TECHNOLOGY_TRANSFORMATION: 70,
  PARTNERSHIP: 60,
  HIRING: 60,
  CAPACITY_CONSTRAINT: 55,
  LEADERSHIP_CHANGE: 40,
  LEADERSHIP: 40,
};

export function scoreOpportunity(
  unparsedInput: OpportunityScoringInput,
): OpportunityScoreResult {
  const input = OpportunityScoringInputSchema.parse(unparsedInput);
  const highIntent = findHighIntent(
    input.claims,
    input.criteria.capabilityTerms,
  );
  const evaluations: Record<OpportunityScoreComponentKey, Evaluation> = {
    sectorFit: evaluateTerms("Sector fit", input.criteria.sectorTerms, input.claims),
    capabilityMatch: evaluateTerms(
      "Capability match",
      input.criteria.capabilityTerms,
      input.claims,
    ),
    targetClientFit: evaluateTerms(
      "Target-client fit",
      input.criteria.targetClientTerms,
      input.claims,
      input.criteria.negativeTerms,
    ),
    outsourcingProbability: evaluateTerms(
      "Outsourcing probability",
      input.criteria.outsourcingTerms,
      input.claims,
    ),
    buyingIntent: evaluateClaimSignals(
      "Buying intent",
      input.claims,
      BUYING_SIGNAL_SCORES,
      highIntent ? 100 : undefined,
    ),
    businessMomentum: evaluateClaimSignals(
      "Business momentum",
      input.claims,
      MOMENTUM_SCORES,
    ),
    decisionMakerQuality: evaluateDownstream(
      "Decision-maker quality",
      input.downstream.decisionMakerQuality,
    ),
    contactConfidence: evaluateDownstream(
      "Contact confidence",
      input.downstream.contactConfidence,
    ),
  };

  const components = componentOrder().map((key) =>
    toComponent(key, input.weights, evaluations[key]),
  );
  const score = Math.round(
    components.reduce(
      (total, component) => total + component.weightedContribution,
      0,
    ),
  );
  const needScore = derivedScore(components, [
    "sectorFit",
    "capabilityMatch",
    "targetClientFit",
    "outsourcingProbability",
  ]);
  const intentScore = derivedScore(components, [
    "buyingIntent",
    "businessMomentum",
  ]);
  const grade = leadGrade(score);
  const qualified = grade !== "REJECT" && score >= input.minimumScore;
  const recommendedAction = scoringAction(
    qualified,
    highIntent !== undefined,
  );
  const evidenceIds = unique(
    components.flatMap((component) => component.evidenceIds),
  );
  const reasons = components.flatMap((component) => component.reasons);

  return OpportunityScoreResultSchema.parse({
    organizationId: input.organizationId,
    score,
    needScore,
    intentScore,
    grade,
    qualified,
    recommendedAction,
    minimumScore: input.minimumScore,
    components,
    reasons,
    evidenceIds,
    highIntentOverride: highIntent
      ? { applied: true, signal: highIntent.signal, evidenceIds: highIntent.evidenceIds }
      : { applied: false, signal: null, evidenceIds: [] },
  });
}

function componentOrder(): OpportunityScoreComponentKey[] {
  return [
    "sectorFit",
    "capabilityMatch",
    "targetClientFit",
    "outsourcingProbability",
    "buyingIntent",
    "businessMomentum",
    "decisionMakerQuality",
    "contactConfidence",
  ];
}

function evaluateTerms(
  label: string,
  terms: readonly string[],
  claims: readonly EvidenceBackedScoringClaim[],
  negativeTerms: readonly string[] = [],
): Evaluation {
  if (terms.length === 0) {
    return emptyEvaluation(`${label}: no configured terms.`);
  }

  const matchedTerms = terms.filter((term) =>
    claims.some((claim) => containsTerm(claim.statement, term)),
  );
  const matchingClaims = claims.filter((claim) =>
    matchedTerms.some((term) => containsTerm(claim.statement, term)),
  );
  const matchedNegativeTerms = negativeTerms.filter((term) =>
    claims.some((claim) => containsTerm(claim.statement, term)),
  );
  const negativeClaims = claims.filter((claim) =>
    matchedNegativeTerms.some((term) => containsTerm(claim.statement, term)),
  );
  const positiveScore = Math.round((matchedTerms.length / terms.length) * 100);
  const rawScore = clamp(positiveScore - matchedNegativeTerms.length * 25);
  const reasons = [
    matchedTerms.length > 0
      ? `${label}: matched ${matchedTerms.join(", ")}.`
      : `${label}: no evidence matched configured terms.`,
  ];
  if (matchedNegativeTerms.length > 0) {
    reasons.push(
      `${label}: negative evidence matched ${matchedNegativeTerms.join(", ")}.`,
    );
  }

  return {
    rawScore,
    confidence: roundToTwo(matchedTerms.length / terms.length),
    reasons,
    evidenceIds: unique(
      [...matchingClaims, ...negativeClaims].flatMap((claim) => claim.evidenceIds),
    ),
  };
}

function evaluateClaimSignals(
  label: string,
  claims: readonly EvidenceBackedScoringClaim[],
  scores: Readonly<
    Partial<Record<EvidenceBackedScoringClaim["type"], number>>
  >,
  overrideScore?: number,
): Evaluation {
  const matchingClaims = claims.filter((claim) => scores[claim.type] !== undefined);
  const rawScore =
    overrideScore ??
    matchingClaims.reduce(
      (highest, claim) => Math.max(highest, scores[claim.type] ?? 0),
      0,
    );
  const signalTypes = unique(matchingClaims.map((claim) => claim.type));
  return {
    rawScore,
    confidence: matchingClaims.length > 0 ? 1 : 0,
    reasons: [
      signalTypes.length > 0
        ? `${label}: evidence includes ${signalTypes.join(", ")}.`
        : `${label}: no supported signal evidence found.`,
    ],
    evidenceIds: unique(matchingClaims.flatMap((claim) => claim.evidenceIds)),
  };
}

function evaluateDownstream(
  label: string,
  factor: ParsedOpportunityScoringInput["downstream"][
    | "decisionMakerQuality"
    | "contactConfidence"],
): Evaluation {
  if (!factor) {
    return emptyEvaluation(`${label}: not evaluated yet.`);
  }
  return {
    rawScore: Math.round(factor.score),
    confidence: factor.confidence,
    reasons: [...factor.reasons],
    evidenceIds: unique(factor.evidenceIds),
  };
}

function findHighIntent(
  claims: readonly EvidenceBackedScoringClaim[],
  capabilityTerms: readonly string[],
): HighIntentMatch | undefined {
  if (capabilityTerms.length === 0) return undefined;
  for (const rule of HIGH_INTENT_RULES) {
    const matches = claims.filter((claim) =>
      (rule.types.includes(claim.type) ||
        rule.terms.some((term) => containsTerm(claim.statement, term))) &&
      hasCapabilityEvidence(claim, claims, capabilityTerms),
    );
    if (matches.length > 0) {
      return {
        signal: rule.signal,
        evidenceIds: unique(matches.flatMap((claim) => claim.evidenceIds)),
      };
    }
  }
  return undefined;
}

function toComponent(
  key: OpportunityScoreComponentKey,
  weights: OpportunityScoreWeights,
  evaluation: Evaluation,
): OpportunityScoreComponent {
  return {
    key,
    rawScore: evaluation.rawScore,
    confidence: evaluation.confidence,
    weight: weights[key],
    weightedContribution: roundToTwo((evaluation.rawScore * weights[key]) / 100),
    reasons: evaluation.reasons,
    evidenceIds: evaluation.evidenceIds,
  };
}

function leadGrade(score: number): LeadGrade {
  if (score >= 90) return "A_PLUS_URGENT";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C_REVIEW";
  return "REJECT";
}

function scoringAction(
  qualified: boolean,
  highIntent: boolean,
): ScoringRecommendedAction {
  if (highIntent) return "URGENT_BDE_REVIEW";
  if (qualified) return "STANDARD_REVIEW";
  return "REJECT";
}

function derivedScore(
  components: readonly OpportunityScoreComponent[],
  keys: readonly OpportunityScoreComponentKey[],
): number {
  const selected = components.filter((component) => keys.includes(component.key));
  const totalWeight = selected.reduce(
    (total, component) => total + component.weight,
    0,
  );
  if (totalWeight === 0) return 0;
  return Math.round(
    selected.reduce(
      (total, component) => total + component.rawScore * component.weight,
      0,
    ) / totalWeight,
  );
}

function hasCapabilityEvidence(
  signalClaim: EvidenceBackedScoringClaim,
  claims: readonly EvidenceBackedScoringClaim[],
  capabilityTerms: readonly string[],
): boolean {
  if (
    capabilityTerms.some((term) => containsTerm(signalClaim.statement, term))
  ) {
    return true;
  }
  const signalEvidence = new Set(signalClaim.evidenceIds);
  return claims.some(
    (claim) =>
      claim.id !== signalClaim.id &&
      claim.evidenceIds.some((evidenceId) => signalEvidence.has(evidenceId)) &&
      capabilityTerms.some((term) => containsTerm(claim.statement, term)),
  );
}

function containsTerm(statement: string, term: string): boolean {
  const haystack = ` ${normalize(statement)} `;
  const needle = normalize(term);
  return needle.length > 0 && haystack.includes(` ${needle} `);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function emptyEvaluation(reason: string): Evaluation {
  return { rawScore: 0, confidence: 0, reasons: [reason], evidenceIds: [] };
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function roundToTwo(value: number): number {
  return Math.round(value * 100) / 100;
}
