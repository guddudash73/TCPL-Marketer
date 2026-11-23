import { createHash } from "node:crypto";

import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@tcpl-marketer/database";

import { DatabaseService } from "../database/database.service.js";
import {
  rankDecisionMakers,
  type DecisionMakerCandidateInput,
  type DecisionMakerProfileInput,
} from "./decision-maker-ranking.service.js";

const SLOT_ORDER = ["PRIMARY", "SECONDARY", "FALLBACK"] as const;

const selectionInclude = {
  assignments: {
    orderBy: { slot: "asc" as const },
    include: {
      person: {
        select: {
          fullName: true,
          confidence: true,
          profileUrl: true,
          sourceProvider: true,
          sourceUrl: true,
        },
      },
      personRole: {
        select: {
          title: true,
          seniority: true,
          departments: true,
          confidence: true,
          sourceUrl: true,
        },
      },
      decisionMakerProfile: {
        select: { title: true, priority: true },
      },
    },
  },
} satisfies Prisma.DecisionMakerSelectionInclude;

type PersistedSelection = Prisma.DecisionMakerSelectionGetPayload<{
  include: typeof selectionInclude;
}>;

const assignmentContextSelect = {
  id: true,
  status: true,
  scores: {
    orderBy: [{ createdAt: "desc" as const }, { id: "desc" as const }],
    take: 1,
    select: { qualified: true },
  },
  campaign: {
    select: {
      capabilities: {
        select: {
          capability: {
            select: {
              name: true,
              decisionMakers: {
                where: { isActive: true },
                orderBy: [{ priority: "asc" as const }, { id: "asc" as const }],
                select: {
                  id: true,
                  title: true,
                  priority: true,
                  seniorities: true,
                  positiveTerms: true,
                  negativeTerms: true,
                },
              },
            },
          },
        },
      },
    },
  },
  organization: {
    select: {
      people: {
        orderBy: [{ normalizedName: "asc" as const }, { id: "asc" as const }],
        select: {
          id: true,
          fullName: true,
          normalizedName: true,
          confidence: true,
          profileUrl: true,
          sourceProvider: true,
          sourceUrl: true,
          roles: {
            where: { isCurrent: true },
            orderBy: [
              { normalizedTitle: "asc" as const },
              { id: "asc" as const },
            ],
            select: {
              id: true,
              title: true,
              normalizedTitle: true,
              seniority: true,
              departments: true,
              confidence: true,
              isCurrent: true,
              sourceUrl: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.LeadCandidateSelect;

type AssignmentContext = Prisma.LeadCandidateGetPayload<{
  select: typeof assignmentContextSelect;
}>;

@Injectable()
export class DecisionMakerAssignmentService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async assign(
    leadCandidateId: string,
    workflowWarnings: string[] = [],
  ): Promise<unknown> {
    const context = await this.loadContext(leadCandidateId);
    const profiles = configuredProfiles(context);
    const candidates = currentCandidates(context);
    const ranked = rankDecisionMakers(candidates, profiles);
    const reviewable = ranked.filter((candidate) => candidate.reviewUrl !== null);
    const excludedUnreviewable = ranked.length - reviewable.length;
    const selected = reviewable.slice(0, SLOT_ORDER.length);
    const missingSlots = SLOT_ORDER.slice(selected.length);
    const warnings = [
      ...new Set([
        ...workflowWarnings,
        ...(excludedUnreviewable > 0
          ? [
              `Excluded ${excludedUnreviewable} candidate${excludedUnreviewable === 1 ? "" : "s"} without a public review URL`,
            ]
          : []),
        ...(missingSlots.length > 0
          ? [
              `Selection needs manual review: missing ${missingSlots.join(", ")} candidate slot${missingSlots.length === 1 ? "" : "s"}`,
            ]
          : []),
      ]),
    ].toSorted();
    const status =
      missingSlots.length === 0 ? "COMPLETE" : "REVIEW_REQUIRED";
    const idempotencyKey = digest(
      JSON.stringify({ leadCandidateId, selected, status, warnings }),
    );
    const existing = await this.database.client.decisionMakerSelection.findUnique({
      where: { idempotencyKey },
      include: selectionInclude,
    });
    if (existing) return selectionResponse(existing, true);

    try {
      const persisted = await this.database.client.decisionMakerSelection.create({
        data: {
          leadCandidateId,
          idempotencyKey,
          status,
          warnings,
          assignments: {
            create: selected.map((candidate, index) => ({
              slot: SLOT_ORDER[index]!,
              person: { connect: { id: candidate.personId } },
              personRole: { connect: { id: candidate.personRoleId } },
              decisionMakerProfile: {
                connect: { id: candidate.decisionMakerProfileId },
              },
              rankScore: candidate.score,
              components: { ...candidate.components },
              reasons: candidate.reasons,
            })),
          },
        },
        include: selectionInclude,
      });
      return selectionResponse(persisted, false);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.database.client.decisionMakerSelection.findUnique({
        where: { idempotencyKey },
        include: selectionInclude,
      });
      if (!raced) throw error;
      return selectionResponse(raced, true);
    }
  }

  async getLatest(leadCandidateId: string): Promise<unknown> {
    const lead = await this.database.client.leadCandidate.findUnique({
      where: { id: leadCandidateId },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException("Lead candidate not found");
    const selection = await this.database.client.decisionMakerSelection.findFirst({
      where: { leadCandidateId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: selectionInclude,
    });
    if (!selection) {
      throw new NotFoundException("No decision-maker selection found");
    }
    return selectionResponse(selection, true);
  }

  private async loadContext(leadCandidateId: string) {
    const context = await this.database.client.leadCandidate.findUnique({
      where: { id: leadCandidateId },
      select: assignmentContextSelect,
    });
    if (!context) throw new NotFoundException("Lead candidate not found");
    if (
      !["QUALIFIED", "BDE_REVIEW"].includes(context.status) ||
      context.scores[0]?.qualified !== true
    ) {
      throw new UnprocessableEntityException(
        "Decision-maker assignment requires a qualified lead candidate",
      );
    }
    return context;
  }
}

function configuredProfiles(
  context: AssignmentContext,
): DecisionMakerProfileInput[] {
  const profiles = new Map<string, DecisionMakerProfileInput>();
  for (const campaignCapability of context.campaign.capabilities) {
    for (const profile of campaignCapability.capability.decisionMakers) {
      profiles.set(profile.id, {
        ...profile,
        capabilityName: campaignCapability.capability.name,
      });
    }
  }
  return [...profiles.values()].toSorted(
    (left, right) => left.priority - right.priority || left.id.localeCompare(right.id),
  );
}

function currentCandidates(
  context: AssignmentContext,
): DecisionMakerCandidateInput[] {
  return context.organization.people.flatMap((person) =>
    person.roles.map((role) => ({
      personId: person.id,
      personRoleId: role.id,
      fullName: person.fullName,
      normalizedName: person.normalizedName,
      personConfidence: person.confidence,
      title: role.title,
      normalizedTitle: role.normalizedTitle,
      seniority: role.seniority,
      departments: role.departments,
      roleConfidence: role.confidence,
      isCurrent: role.isCurrent,
      reviewUrl: role.sourceUrl ?? person.sourceUrl ?? person.profileUrl,
    })),
  );
}

function selectionResponse(selection: PersistedSelection, cached: boolean) {
  const bySlot = new Map(
    selection.assignments.map((assignment) => [assignment.slot, assignment]),
  );
  return {
    id: selection.id,
    leadCandidateId: selection.leadCandidateId,
    status: selection.status,
    warnings: selection.warnings,
    createdAt: selection.createdAt,
    cached,
    missingSlots: SLOT_ORDER.filter((slot) => !bySlot.has(slot)),
    assignments: SLOT_ORDER.flatMap((slot) => {
      const assignment = bySlot.get(slot);
      if (!assignment) return [];
      return [{
        id: assignment.id,
        slot,
        rankScore: assignment.rankScore,
        components: assignment.components,
        reasons: assignment.reasons,
        person: assignment.person,
        role: assignment.personRole,
        reviewUrl:
          assignment.personRole.sourceUrl ??
          assignment.person.sourceUrl ??
          assignment.person.profileUrl,
        matchedProfile: assignment.decisionMakerProfile,
      }];
    }),
  };
}

function digest(value: string): string {
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
