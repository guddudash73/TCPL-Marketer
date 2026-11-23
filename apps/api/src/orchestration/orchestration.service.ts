import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { requireCampaignTransition } from "../campaigns/campaign-state-machine.js";
import { DatabaseService } from "../database/database.service.js";
import { OutboxDispatcherService } from "./outbox-dispatcher.service.js";

const CAMPAIGN_STARTED = "CAMPAIGN_STARTED";

@Injectable()
export class OrchestrationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(OutboxDispatcherService)
    private readonly dispatcher: OutboxDispatcherService,
  ) {}

  async startCampaign(id: string, actorUserId: string): Promise<unknown> {
    const dispatch = await this.prepareCampaignStart(id, actorUserId);

    if (dispatch.event.status === "PUBLISHED") {
      return dispatch;
    }
    if (dispatch.event.status === "DEAD_LETTER") {
      throw new ConflictException(
        "Campaign start failed permanently and needs an operator retry",
      );
    }

    // A user asking again is an explicit retry, so it does not wait for backoff.
    const outcome = await this.dispatcher.dispatchEvent(dispatch.event.id, {
      ignoreBackoff: true,
    });
    if (outcome.kind === "RETRY_SCHEDULED") {
      throw new BadGatewayException(
        "Campaign start was recorded and remains pending orchestration retry",
      );
    }
    if (outcome.kind === "DEAD_LETTERED") {
      throw new ConflictException(
        "Campaign start failed permanently and needs an operator retry",
      );
    }
    if (outcome.kind === "HELD") {
      throw new ConflictException("Campaign cannot be dispatched in its current state");
    }
    return this.readDispatchState(id, dispatch.event.id);
  }

  private async readDispatchState(campaignId: string, eventId: string) {
    const [campaign, event, automationRun] = await Promise.all([
      this.database.client.campaign.findUniqueOrThrow({ where: { id: campaignId } }),
      this.database.client.outboxEvent.findUniqueOrThrow({ where: { id: eventId } }),
      this.database.client.automationRun.findUnique({
        where: { outboxEventId: eventId },
      }),
    ]);
    return { campaign, event, automationRun };
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
