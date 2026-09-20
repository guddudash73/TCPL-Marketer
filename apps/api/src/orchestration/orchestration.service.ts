import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  ORCHESTRATION_GATEWAY,
  type OrchestrationEvent,
  type OrchestrationGateway,
} from "@tcpl-marketer/orchestration-contracts";

import { requireCampaignTransition } from "../campaigns/campaign-state-machine.js";
import { DatabaseService } from "../database/database.service.js";

const CAMPAIGN_STARTED = "CAMPAIGN_STARTED";

@Injectable()
export class OrchestrationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ORCHESTRATION_GATEWAY)
    private readonly gateway: OrchestrationGateway,
  ) {}

  async startCampaign(id: string, actorUserId: string): Promise<unknown> {
    const dispatch = await this.prepareCampaignStart(id, actorUserId);

    if (dispatch.event.status === "PUBLISHED") {
      return dispatch;
    }

    const event: OrchestrationEvent = {
      id: dispatch.event.id,
      eventType: dispatch.event.eventType,
      aggregateType: dispatch.event.aggregateType,
      aggregateId: dispatch.event.aggregateId,
      payload: dispatch.event.payload as Record<string, unknown>,
      createdAt: dispatch.event.createdAt.toISOString(),
    };

    try {
      const result = await this.gateway.publish(event);
      return await this.database.client.$transaction(async (transaction) => {
        const now = new Date();
        const publishedEvent = await transaction.outboxEvent.update({
          where: { id: event.id },
          data: {
            status: "PUBLISHED",
            attempts: { increment: 1 },
            publishedAt: now,
            lastError: null,
          },
        });
        const automationRun = await transaction.automationRun.update({
          where: { outboxEventId: event.id },
          data: {
            status: "RUNNING",
            attempts: { increment: 1 },
            externalRunId: result.externalRunId,
            startedAt: now,
            lastError: null,
          },
        });
        const campaign = await transaction.campaign.update({
          where: { id, status: "STARTING" },
          data: { status: "RUNNING" },
        });
        await transaction.auditLog.create({
          data: {
            action: "campaign.started",
            resourceType: "campaign",
            resourceId: id,
            actorUserId,
            metadata: { outboxEventId: event.id, automationRunId: automationRun.id },
          },
        });
        return { campaign, event: publishedEvent, automationRun };
      });
    } catch (error) {
      const message = safeErrorMessage(error);
      await this.database.client.$transaction([
        this.database.client.outboxEvent.update({
          where: { id: event.id },
          data: { attempts: { increment: 1 }, lastError: message },
        }),
        this.database.client.automationRun.update({
          where: { outboxEventId: event.id },
          data: {
            status: "FAILED",
            attempts: { increment: 1 },
            lastError: message,
          },
        }),
      ]);
      throw new BadGatewayException(
        "Campaign start was recorded and remains pending orchestration retry",
      );
    }
  }

  async getCampaignContext(id: string): Promise<unknown> {
    const campaign = await this.database.client.campaign.findUnique({
      where: { id },
      include: {
        sector: true,
        capabilities: { include: { capability: true } },
        deliverables: { include: { deliverable: true } },
        targets: { include: { targetClientProfile: true } },
        sequenceSteps: { orderBy: { stepNumber: "asc" } },
      },
    });
    if (!campaign) throw new NotFoundException(`Campaign ${id} was not found`);
    if (campaign.status !== "STARTING" && campaign.status !== "RUNNING") {
      throw new ConflictException("Campaign is not ready for orchestration");
    }
    return campaign;
  }

  private async prepareCampaignStart(id: string, actorUserId: string) {
    return this.database.client.$transaction(async (transaction) => {
      const existingEvent = await transaction.outboxEvent.findUnique({
        where: { idempotencyKey: `campaign-start:${id}` },
        include: { automationRun: true },
      });
      if (existingEvent) {
        const campaign = await transaction.campaign.findUnique({
          where: { id },
        });
        if (!campaign) throw new NotFoundException(`Campaign ${id} was not found`);
        return {
          campaign,
          event: existingEvent,
          automationRun: existingEvent.automationRun,
        };
      }

      const campaign = await transaction.campaign.findUnique({ where: { id } });
      if (!campaign) throw new NotFoundException(`Campaign ${id} was not found`);
      try {
        requireCampaignTransition(campaign.status, "STARTING");
      } catch {
        throw new BadRequestException(
          `Campaign cannot be started from ${campaign.status}`,
        );
      }

      const updated = await transaction.campaign.updateMany({
        where: { id, status: campaign.status },
        data: { status: "STARTING" },
      });
      if (updated.count !== 1) {
        throw new ConflictException("Campaign state changed; retry the request");
      }

      const event = await transaction.outboxEvent.create({
        data: {
          eventType: CAMPAIGN_STARTED,
          aggregateType: "campaign",
          aggregateId: id,
          idempotencyKey: `campaign-start:${id}`,
          payload: { campaignId: id, actorUserId },
        },
      });
      const automationRun = await transaction.automationRun.create({
        data: {
          campaignId: id,
          outboxEventId: event.id,
          provider: "n8n",
        },
      });
      await transaction.auditLog.create({
        data: {
          action: "campaign.start_requested",
          resourceType: "campaign",
          resourceId: id,
          actorUserId,
          metadata: { outboxEventId: event.id, automationRunId: automationRun.id },
        },
      });
      return { campaign: { ...campaign, status: "STARTING" }, event, automationRun };
    });
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 2_000);
  return "Unknown orchestration error";
}
