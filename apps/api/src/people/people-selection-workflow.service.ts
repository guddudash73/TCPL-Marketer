import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import type { PeopleProvider, PersonCandidate } from "@tcpl-marketer/provider-contracts";
import { PeopleSearchInputSchema } from "@tcpl-marketer/validation";

import { DatabaseService } from "../database/database.service.js";
import { assertDiagnosticClaim } from "../acceptance/diagnostic-claim.js";
import { ApolloPeopleSearchAdapter } from "./apollo-people-search.adapter.js";
import { DecisionMakerAssignmentService } from "./decision-maker-assignment.service.js";
import { PeoplePersistenceService } from "./people-persistence.service.js";
import { PublicPeopleSearchAdapter } from "./public-people-search.adapter.js";

@Injectable()
export class PeopleSelectionWorkflowService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(PublicPeopleSearchAdapter)
    private readonly publicPeople: PublicPeopleSearchAdapter,
    @Inject(ApolloPeopleSearchAdapter)
    private readonly apolloPeople: ApolloPeopleSearchAdapter,
    @Inject(PeoplePersistenceService)
    private readonly persistence: PeoplePersistenceService,
    @Inject(DecisionMakerAssignmentService)
    private readonly assignments: DecisionMakerAssignmentService,
  ) {}

  async selectDecisionMakers(
    leadCandidateId: string,
    diagnosticRunId?: string,
    inputHash?: string,
  ): Promise<unknown> {
    const claim = await assertDiagnosticClaim(
      this.database.client,
      leadCandidateId,
      diagnosticRunId,
      inputHash,
    );
    const context = await this.loadContext(leadCandidateId);
    if (claim && claim.candidateUpdatedAt.getTime() !== context.updatedAt.getTime()) {
      throw new ConflictException(
        "Lead candidate changed before F001 people selection; reconcile before continuing",
      );
    }
    const roles = context.campaign.capabilities.flatMap(({ capability }) =>
      capability.decisionMakers.map((profile) => ({
        decisionMakerProfileId: profile.id,
        title: profile.title,
        priority: profile.priority,
        seniorities: profile.seniorities,
        positiveTerms: profile.positiveTerms,
        negativeTerms: profile.negativeTerms,
      })),
    );
    const warnings: string[] = [];
    const candidates: PersonCandidate[] = [];

    if (roles.length === 0) {
      warnings.push("No active decision-maker profiles are configured for this campaign");
    } else {
      const input = PeopleSearchInputSchema.parse({
        organization: {
          id: context.organization.id,
          name: context.organization.name,
          domain: context.organization.normalizedDomain,
          location: context.organization.location,
        },
        roles,
        maximumResults: 25,
      });
      for (const [providerName, provider] of this.providers()) {
        try {
          candidates.push(...(await provider.searchPeople(input)));
        } catch (error) {
          warnings.push(`${providerName} discovery unavailable: ${safeMessage(error)}`);
        }
      }
    }

    let persistedCandidates = 0;
    for (const candidate of uniqueCandidates(candidates)) {
      try {
        await this.persistence.persistCandidate(context.organization.id, candidate);
        persistedCandidates += 1;
      } catch (error) {
        warnings.push(
          `Candidate ${candidate.normalizedName} could not be persisted: ${safeMessage(error)}`,
        );
      }
    }

    const selection = await this.assignments.assign(leadCandidateId, warnings);
    return {
      leadCandidateId,
      discovery: {
        attemptedProviders: roles.length === 0 ? [] : ["public-web", "apollo"],
        discoveredCandidates: candidates.length,
        persistedCandidates,
        warnings: [...new Set(warnings)].toSorted(),
      },
      selection,
    };
  }

  private providers(): Array<[string, PeopleProvider]> {
    return [
      ["Public-web", this.publicPeople],
      ["Apollo", this.apolloPeople],
    ];
  }

  private async loadContext(leadCandidateId: string) {
    const context = await this.database.client.leadCandidate.findUnique({
      where: { id: leadCandidateId },
      select: {
        updatedAt: true,
        status: true,
        scores: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { qualified: true },
        },
        organization: {
          select: {
            id: true,
            name: true,
            normalizedDomain: true,
            location: true,
          },
        },
        campaign: {
          select: {
            capabilities: {
              select: {
                capability: {
                  select: {
                    decisionMakers: {
                      where: { isActive: true },
                      orderBy: [{ priority: "asc" }, { id: "asc" }],
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
      },
    });
    if (!context) throw new NotFoundException("Lead candidate not found");
    if (
      !["QUALIFIED", "BDE_REVIEW"].includes(context.status) ||
      context.scores[0]?.qualified !== true
    ) {
      throw new UnprocessableEntityException(
        "People selection requires a qualified lead candidate",
      );
    }
    return context;
  }
}

function uniqueCandidates(candidates: PersonCandidate[]): PersonCandidate[] {
  const unique = new Map<string, PersonCandidate>();
  for (const candidate of candidates) {
    const key = [
      candidate.source.provider.toLocaleLowerCase("en-US"),
      candidate.source.externalId ?? candidate.normalizedName,
      candidate.role.normalizedTitle,
    ].join("|");
    const existing = unique.get(key);
    if (
      !existing ||
      candidate.confidence + candidate.role.confidence >
        existing.confidence + existing.role.confidence
    ) {
      unique.set(key, candidate);
    }
  }
  return [...unique.values()];
}

function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "unknown provider error").slice(
    0,
    300,
  );
}
