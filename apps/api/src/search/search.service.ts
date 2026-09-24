import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  SEARCH_PLANNER,
  SEARCH_PROVIDER,
  type ProviderRun,
  type SearchCampaignContext,
  type SearchPlanner,
  type SearchProvider,
} from "@tcpl-marketer/provider-contracts";

import { DatabaseService } from "../database/database.service.js";
import { OrganizationResolutionService } from "./organization-resolution.service.js";

@Injectable()
export class SearchService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SEARCH_PLANNER) private readonly planner: SearchPlanner,
    @Inject(SEARCH_PROVIDER) private readonly provider: SearchProvider,
    @Inject(OrganizationResolutionService)
    private readonly organizationResolution: OrganizationResolutionService,
  ) {}

  async prepareDiscovery(campaignId: string): Promise<unknown> {
    const campaign = await this.database.client.campaign.findUnique({
      where: { id: campaignId },
      include: {
        sector: true,
        capabilities: { include: { capability: true } },
        deliverables: { include: { deliverable: true } },
        targets: { include: { targetClientProfile: true } },
      },
    });
    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} was not found`);
    }
    if (campaign.status !== "STARTING" && campaign.status !== "RUNNING") {
      throw new ConflictException("Campaign is not ready for discovery");
    }

    const context: SearchCampaignContext = {
      campaignId: campaign.id,
      sector: {
        name: campaign.sector.name,
        description: campaign.sector.description,
        terminology: campaign.sector.terminology,
        negativeTerms: campaign.sector.negativeTerms,
      },
      capabilities: campaign.capabilities.map(({ capability }) => ({
        name: capability.name,
        description: capability.description,
        businessProblems: capability.businessProblems,
        businessValue: capability.businessValue,
        searchGuidance: jsonRecord(capability.searchGuidance),
      })),
      deliverables: campaign.deliverables.map(({ deliverable }) => ({
        name: deliverable.name,
        description: deliverable.description,
      })),
      targetProfiles: campaign.targets.map(({ targetClientProfile }) => ({
        name: targetClientProfile.name,
        companyCharacteristics: jsonRecord(
          targetClientProfile.companyCharacteristics,
        ),
        positiveTerms: targetClientProfile.positiveTerms,
        negativeTerms: targetClientProfile.negativeTerms,
        typicalBusinessModel: targetClientProfile.typicalBusinessModel,
        outsourcingCharacteristics:
          targetClientProfile.outsourcingCharacteristics,
      })),
      geography: {
        countries: campaign.countries,
        states: campaign.states,
        cities: campaign.cities,
      },
      employeeRange: {
        minimum: campaign.minimumEmployees,
        maximum: campaign.maximumEmployees,
      },
      targetLeadCount: campaign.targetLeadCount,
    };

    const planning = await this.planner.plan(context);
    const discovery = await this.provider.search({
      context,
      plan: planning.data,
      maximumResults: Math.min(campaign.targetLeadCount, 10),
    });
    const persistence = await this.organizationResolution.persistDiscovery(
      campaignId,
      context.geography,
      discovery.data,
    );

    return {
      campaignId,
      plan: planning.data,
      results: discovery.data,
      persistence,
      provider: "openai",
      runs: {
        planning: withoutData(planning),
        discovery: withoutData(discovery),
      },
    };
  }
}

function jsonRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function withoutData<T>(run: ProviderRun<T>) {
  return {
    model: run.model,
    providerResponseId: run.providerResponseId,
    prompt: run.prompt,
    usage: run.usage,
  };
}
