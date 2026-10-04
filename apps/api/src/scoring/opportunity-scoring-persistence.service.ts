import { createHash } from "node:crypto";

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@tcpl-marketer/database";
import {
  OpportunityScoreResultSchema,
  OpportunityScoreWeightsSchema,
  type OpportunityScoreWeights,
  type OpportunityScoringInput,
} from "@tcpl-marketer/validation";

import { DatabaseService } from "../database/database.service.js";
import { scoreOpportunity } from "./opportunity-scoring.service.js";

const scoreSelect = {
  id: true,
  leadCandidateId: true,
  claimExtractionRunId: true,
  score: true,
  needScore: true,
  intentScore: true,
  grade: true,
  qualified: true,
  recommendedAction: true,
  minimumScore: true,
  weights: true,
  components: true,
  reasons: true,
  evidenceIds: true,
  highIntentOverride: true,
  createdAt: true,
  leadCandidate: { select: { organizationId: true, status: true } },
} satisfies Prisma.LeadScoreSelect;

type PersistedScore = Prisma.LeadScoreGetPayload<{ select: typeof scoreSelect }>;

const candidateInclude = {
  campaign: {
    include: {
      sector: true,
      capabilities: { include: { capability: true } },
      deliverables: { include: { deliverable: true } },
      targets: { include: { targetClientProfile: true } },
    },
  },
} satisfies Prisma.LeadCandidateInclude;

const profileInclude = {
  claims: {
    orderBy: [{ createdAt: "asc" as const }, { id: "asc" as const }],
    include: {
      evidence: {
        orderBy: { sourceId: "asc" as const },
        select: { sourceId: true },
      },
    },
  },
} satisfies Prisma.ClaimExtractionRunInclude;

type ScoringCandidate = Prisma.LeadCandidateGetPayload<{
  include: typeof candidateInclude;
}>;
type ScoringProfile = Prisma.ClaimExtractionRunGetPayload<{
  include: typeof profileInclude;
}>;

@Injectable()
export class OpportunityScoringPersistenceService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async scoreLeadCandidate(candidateId: string): Promise<unknown> {
    const context = await this.loadContext(candidateId);
    const weights = configuredScoringWeights(context.candidate.campaign);
    const input = scoringInput(context, weights);
    const result = scoreOpportunity(input);
    const idempotencyKey = sha256(
      JSON.stringify({
        candidateId,
        claimExtractionRunId: context.profile.id,
        input,
      }),
    );
    const existing = await this.database.client.leadScore.findUnique({
      where: { idempotencyKey },
      select: scoreSelect,
    });
    if (existing) return scoreResponse(existing, true);

    try {
      const persisted = await this.database.client.$transaction(
        async (transaction) => {
          const transitioned = await transaction.leadCandidate.updateMany({
            where: {
              id: candidateId,
              status: {
                in: [
                  "ANALYSING",
                  "SCORING",
                  "QUALIFIED",
                  "BDE_REVIEW",
                  "REJECTED",
                ],
              },
            },
            data: { status: "SCORING" },
          });
          if (transitioned.count !== 1) {
            throw new ConflictException(
              "Lead candidate must complete research before scoring",
            );
          }
          const score = await transaction.leadScore.create({
            data: {
              leadCandidateId: candidateId,
              claimExtractionRunId: context.profile.id,
              idempotencyKey,
              score: result.score,
              needScore: result.needScore,
              intentScore: result.intentScore,
              grade: result.grade,
              qualified: result.qualified,
              recommendedAction: result.recommendedAction,
              minimumScore: result.minimumScore,
              weights,
              components: result.components,
              reasons: result.reasons,
              evidenceIds: result.evidenceIds,
              highIntentOverride: result.highIntentOverride,
            },
            select: { id: true },
          });
          await transaction.leadCandidate.update({
            where: { id: candidateId },
            data: { status: candidateStatus(result) },
          });
          return transaction.leadScore.findUniqueOrThrow({
            where: { id: score.id },
            select: scoreSelect,
          });
        },
      );
      return scoreResponse(persisted, false);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.database.client.leadScore.findUnique({
        where: { idempotencyKey },
        select: scoreSelect,
      });
      if (!raced) throw error;
      return scoreResponse(raced, true);
    }
  }

  async getLatestScore(candidateId: string): Promise<unknown> {
    const candidate = await this.database.client.leadCandidate.findUnique({
      where: { id: candidateId },
      select: { id: true },
    });
    if (!candidate) throw new NotFoundException("Lead candidate not found");
    const score = await this.database.client.leadScore.findFirst({
      where: { leadCandidateId: candidateId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: scoreSelect,
    });
    if (!score) throw new NotFoundException("No persisted lead score found");
    return scoreResponse(score, true);
  }

  private async loadContext(candidateId: string) {
    const candidate = await this.database.client.leadCandidate.findUnique({
      where: { id: candidateId },
      include: candidateInclude,
    });
    if (!candidate) throw new NotFoundException("Lead candidate not found");
    const profile = await this.database.client.claimExtractionRun.findFirst({
      where: { organizationId: candidate.organizationId, status: "SUCCEEDED" },
      orderBy: { completedAt: "desc" },
      include: profileInclude,
    });
    if (!profile) {
      throw new UnprocessableEntityException(
        "A completed company research profile is required before scoring",
      );
    }
    if (profile.claims.length === 0) {
      throw new UnprocessableEntityException(
        "The completed company research profile has no evidence-backed claims",
      );
    }
    return { candidate, profile };
  }
}

function scoringInput(
  context: { candidate: ScoringCandidate; profile: ScoringProfile },
  weights: OpportunityScoreWeights,
): OpportunityScoringInput {
  const { candidate, profile } = context;
  const capabilities = candidate.campaign.capabilities.map(
    ({ capability }) => capability,
  );
  const targets = candidate.campaign.targets.map(
    ({ targetClientProfile }) => targetClientProfile,
  );
  return {
    organizationId: candidate.organizationId,
    claims: profile.claims.map((claim) => ({
      id: claim.id,
      type: claim.claimType as OpportunityScoringInput["claims"][number]["type"],
      statement: claim.statement,
      evidenceIds: claim.evidence.map(({ sourceId }) => sourceId),
    })),
    criteria: {
      sectorTerms: configuredTerms([
        candidate.campaign.sector.name,
        ...candidate.campaign.sector.terminology,
      ]),
      capabilityTerms: configuredTerms([
        ...capabilities.flatMap((capability) => [
          capability.name,
          ...capability.businessProblems,
        ]),
        ...candidate.campaign.deliverables.map(
          ({ deliverable }) => deliverable.name,
        ),
      ]),
      targetClientTerms: configuredTerms(
        targets.flatMap((target) => [target.name, ...target.positiveTerms]),
      ),
      outsourcingTerms: configuredTerms(
        targets.flatMap((target) => [
          target.outsourcingCharacteristics,
          ...target.positiveTerms.filter((term) =>
            /outsourc|vendor|subcontract|partner/i.test(term),
          ),
        ]),
      ),
      negativeTerms: configuredTerms([
        ...candidate.campaign.sector.negativeTerms,
        ...targets.flatMap((target) => target.negativeTerms),
      ]),
    },
    weights,
    minimumScore: candidate.campaign.minimumScore,
  };
}

function configuredScoringWeights(
  campaign: ScoringCandidate["campaign"],
): OpportunityScoreWeights {
  return {
    sectorFit: campaign.sectorFitWeight,
    capabilityMatch: campaign.capabilityMatchWeight,
    targetClientFit: campaign.targetClientFitWeight,
    outsourcingProbability: campaign.outsourcingWeight,
    buyingIntent: campaign.buyingIntentWeight,
    businessMomentum: campaign.businessMomentumWeight,
    decisionMakerQuality: campaign.decisionMakerWeight,
    contactConfidence: campaign.contactConfidenceWeight,
  };
}

function configuredTerms(values: Array<string | null | undefined>): string[] {
  return [
    ...new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => Boolean(value && value.length <= 160)),
    ),
  ]
    .toSorted((left, right) => left.localeCompare(right))
    .slice(0, 100);
}

function scoreResponse(score: PersistedScore, cached: boolean) {
  const result = OpportunityScoreResultSchema.parse({
    organizationId: score.leadCandidate.organizationId,
    score: score.score,
    needScore: score.needScore,
    intentScore: score.intentScore,
    grade: score.grade,
    qualified: score.qualified,
    recommendedAction: score.recommendedAction,
    minimumScore: score.minimumScore,
    components: score.components,
    reasons: score.reasons,
    evidenceIds: score.evidenceIds,
    highIntentOverride: score.highIntentOverride,
  });
  return {
    id: score.id,
    leadCandidateId: score.leadCandidateId,
    claimExtractionRunId: score.claimExtractionRunId,
    candidateStatus: score.leadCandidate.status,
    createdAt: score.createdAt,
    cached,
    weights: OpportunityScoreWeightsSchema.parse(score.weights),
    result,
  };
}

function candidateStatus(
  result: ReturnType<typeof scoreOpportunity>,
): "QUALIFIED" | "BDE_REVIEW" | "REJECTED" {
  if (result.recommendedAction === "URGENT_BDE_REVIEW") return "BDE_REVIEW";
  return result.qualified ? "QUALIFIED" : "REJECTED";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}
