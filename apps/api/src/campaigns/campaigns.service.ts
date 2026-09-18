import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";

import { AuditService } from "../audit/audit.service.js";
import { DatabaseService } from "../database/database.service.js";
import type {
  CreateCampaignInput,
  UpdateCampaignInput,
} from "./campaign.schemas.js";

const campaignInclude = {
  sector: true,
  createdBy: { select: { id: true, email: true, displayName: true } },
  capabilities: { include: { capability: true } },
  deliverables: { include: { deliverable: true } },
  targets: { include: { targetClientProfile: true } },
  sequenceSteps: { orderBy: { stepNumber: "asc" as const } },
} as const;

interface CampaignConfiguration {
  sectorId: string;
  capabilityIds: string[];
  deliverableIds: string[];
  targetClientProfileIds: string[];
  minimumEmployees?: number | null;
  maximumEmployees?: number | null;
}

@Injectable()
export class CampaignsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  async list(): Promise<unknown> {
    return this.database.client.campaign.findMany({
      include: campaignInclude,
      orderBy: { createdAt: "desc" },
    });
  }

  async get(id: string): Promise<unknown> {
    return this.requireCampaign(id);
  }

  async create(
    input: CreateCampaignInput,
    actorUserId: string,
  ): Promise<unknown> {
    await this.validateConfiguration(input);
    const campaign = await this.database.client.campaign.create({
      data: {
        name: input.name,
        sectorId: input.sectorId,
        createdByUserId: actorUserId,
        automationMode: input.automationMode,
        researchDepth: input.researchDepth,
        countries: input.countries,
        states: input.states ?? [],
        cities: input.cities ?? [],
        minimumEmployees: input.minimumEmployees,
        maximumEmployees: input.maximumEmployees,
        targetLeadCount: input.targetLeadCount,
        minimumScore: input.minimumScore,
        dailyEmailLimit: input.dailyEmailLimit,
        capabilities: {
          create: input.capabilityIds.map((capabilityId) => ({ capabilityId })),
        },
        deliverables: {
          create: input.deliverableIds.map((deliverableId) => ({
            deliverableId,
          })),
        },
        targets: {
          create: input.targetClientProfileIds.map((targetClientProfileId) => ({
            targetClientProfileId,
          })),
        },
        sequenceSteps: { create: input.sequence },
      },
      include: campaignInclude,
    });
    await this.audit.record({
      action: "campaign.created",
      resourceType: "campaign",
      resourceId: campaign.id,
      actorUserId,
      metadata: {
        automationMode: campaign.automationMode,
        status: campaign.status,
      },
    });
    return campaign;
  }

  async update(
    id: string,
    input: UpdateCampaignInput,
    actorUserId: string,
  ): Promise<unknown> {
    const existing = await this.requireCampaign(id);
    this.requireDraft(existing.status);

    const configuration: CampaignConfiguration = {
      sectorId: input.sectorId ?? existing.sectorId,
      capabilityIds:
        input.capabilityIds ??
        existing.capabilities.map(({ capabilityId }) => capabilityId),
      deliverableIds:
        input.deliverableIds ??
        existing.deliverables.map(({ deliverableId }) => deliverableId),
      targetClientProfileIds:
        input.targetClientProfileIds ??
        existing.targets.map(
          ({ targetClientProfileId }) => targetClientProfileId,
        ),
      minimumEmployees:
        input.minimumEmployees === undefined
          ? existing.minimumEmployees
          : input.minimumEmployees,
      maximumEmployees:
        input.maximumEmployees === undefined
          ? existing.maximumEmployees
          : input.maximumEmployees,
    };
    await this.validateConfiguration(configuration);

    const campaign = await this.database.client.campaign.update({
      where: { id },
      data: {
        name: input.name,
        sectorId: input.sectorId,
        automationMode: input.automationMode,
        researchDepth: input.researchDepth,
        countries: input.countries,
        states: input.states,
        cities: input.cities,
        minimumEmployees: input.minimumEmployees,
        maximumEmployees: input.maximumEmployees,
        targetLeadCount: input.targetLeadCount,
        minimumScore: input.minimumScore,
        dailyEmailLimit: input.dailyEmailLimit,
        capabilities: input.capabilityIds
          ? {
              deleteMany: {},
              create: input.capabilityIds.map((capabilityId) => ({
                capabilityId,
              })),
            }
          : undefined,
        deliverables: input.deliverableIds
          ? {
              deleteMany: {},
              create: input.deliverableIds.map((deliverableId) => ({
                deliverableId,
              })),
            }
          : undefined,
        targets: input.targetClientProfileIds
          ? {
              deleteMany: {},
              create: input.targetClientProfileIds.map(
                (targetClientProfileId) => ({ targetClientProfileId }),
              ),
            }
          : undefined,
        sequenceSteps: input.sequence
          ? { deleteMany: {}, create: input.sequence }
          : undefined,
      },
      include: campaignInclude,
    });
    await this.audit.record({
      action: "campaign.updated",
      resourceType: "campaign",
      resourceId: campaign.id,
      actorUserId,
    });
    return campaign;
  }

  async delete(id: string, actorUserId: string): Promise<{ id: string }> {
    const existing = await this.requireCampaign(id);
    this.requireDraft(existing.status);
    await this.database.client.campaign.delete({ where: { id } });
    await this.audit.record({
      action: "campaign.deleted",
      resourceType: "campaign",
      resourceId: id,
      actorUserId,
    });
    return { id };
  }

  private async requireCampaign(id: string) {
    const campaign = await this.database.client.campaign.findUnique({
      where: { id },
      include: campaignInclude,
    });
    if (!campaign) throw new NotFoundException(`Campaign ${id} was not found`);
    return campaign;
  }

  private requireDraft(status: string): void {
    if (status !== "DRAFT")
      throw new BadRequestException("Only DRAFT campaigns can be changed");
  }

  private async validateConfiguration(
    configuration: CampaignConfiguration,
  ): Promise<void> {
    if (
      configuration.minimumEmployees != null &&
      configuration.maximumEmployees != null &&
      configuration.minimumEmployees > configuration.maximumEmployees
    ) {
      throw new BadRequestException(
        "minimumEmployees must not exceed maximumEmployees",
      );
    }

    const sector = await this.database.client.sector.findFirst({
      where: { id: configuration.sectorId, isActive: true },
      select: { id: true },
    });
    const capabilities = await this.database.client.serviceCapability.findMany({
      where: {
        id: { in: configuration.capabilityIds },
        sectorId: configuration.sectorId,
        isActive: true,
      },
      select: { id: true },
    });
    const deliverables =
      await this.database.client.capabilityDeliverable.findMany({
        where: {
          id: { in: configuration.deliverableIds },
          capabilityId: { in: configuration.capabilityIds },
          isActive: true,
        },
        select: { id: true },
      });
    const targets = await this.database.client.targetClientProfile.findMany({
      where: {
        id: { in: configuration.targetClientProfileIds },
        capabilityId: { in: configuration.capabilityIds },
        isActive: true,
      },
      select: { id: true },
    });

    if (!sector)
      throw new BadRequestException("Campaign sector must exist and be active");
    if (capabilities.length !== configuration.capabilityIds.length) {
      throw new BadRequestException(
        "Every capability must be active and belong to the campaign sector",
      );
    }
    if (deliverables.length !== configuration.deliverableIds.length) {
      throw new BadRequestException(
        "Every deliverable must be active and belong to a selected capability",
      );
    }
    if (targets.length !== configuration.targetClientProfileIds.length) {
      throw new BadRequestException(
        "Every target profile must be active and belong to a selected capability",
      );
    }
  }
}
