import { randomUUID } from "node:crypto";

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { STAGE_DEFINITIONS } from "@tcpl-marketer/orchestration-contracts";

import { bindCampaign, bindStageRun } from "../common/correlation/correlation-context.js";
import { DatabaseService } from "../database/database.service.js";
import { SearchService } from "../search/search.service.js";
import { readOutboxDispatchConfig } from "./outbox-dispatch.config.js";
import { StageRunService, type StageRunRecord } from "./stage-run.service.js";

export interface DiscoveryInProgress {
  status: "IN_PROGRESS";
  campaignId: string;
  stageRunId: string;
}

export function isDiscoveryInProgress(value: unknown): value is DiscoveryInProgress {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { status?: unknown }).status === "IN_PROGRESS"
  );
}

/**
 * Consumer side of CAMPAIGN_STARTED. One start event maps to one discovery
 * stage run, so a re-published event returns the stored result instead of
 * paying for search again.
 */
@Injectable()
export class DiscoveryStageService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SearchService) private readonly search: SearchService,
    @Inject(StageRunService) private readonly stageRuns: StageRunService,
  ) {}

  async run(campaignId: string): Promise<unknown> {
    bindCampaign(campaignId);
    const campaign = await this.database.client.campaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });
    if (!campaign) {
      throw new NotFoundException(`Campaign ${campaignId} was not found`);
    }
    if (campaign.status !== "STARTING" && campaign.status !== "RUNNING") {
      throw new ConflictException("Campaign is not ready for discovery");
    }
    const startEvent = await this.database.client.outboxEvent.findUnique({
      where: { idempotencyKey: `campaign-start:${campaignId}` },
      select: { id: true },
    });
    if (!startEvent) {
      throw new ConflictException("Campaign has no recorded start event");
    }

    const { run } = await this.stageRuns.ensure({
      campaignId,
      stage: "DISCOVERY",
      entityType: STAGE_DEFINITIONS.DISCOVERY.entityType,
      entityId: campaignId,
      input: { startEventId: startEvent.id },
    });
    bindStageRun(run.id);
    if (run.status === "RUNNING") await this.stageRuns.reclaimIfExpired(run.id);

    const { stageLeaseSeconds } = readOutboxDispatchConfig();
    const leaseOwner = `discovery:${process.pid}:${randomUUID()}`;
    const claim = await this.stageRuns.claim(run.id, leaseOwner, stageLeaseSeconds);
    if (!claim.claimed) {
      if (claim.reason === "CAMPAIGN_NOT_DISPATCHABLE") {
        throw new ConflictException("Campaign is not ready for discovery");
      }
      return this.currentResult(run.id, campaignId);
    }

    const heartbeat = setInterval(() => {
      void this.stageRuns
        .heartbeat(run.id, leaseOwner, stageLeaseSeconds)
        .catch(() => undefined);
    }, (stageLeaseSeconds * 1_000) / 3);
    heartbeat.unref();

    try {
      const result = await this.search.prepareDiscovery(campaignId);
      await this.stageRuns.finish(run.id, {
        leaseOwner,
        actor: STAGE_DEFINITIONS.DISCOVERY.domainOwner,
        status: "SUCCEEDED",
        outcome: "DISCOVERED",
        result,
      });
      return result;
    } catch (error) {
      // Stored text is generic because provider errors can echo request details.
      await this.stageRuns
        .release(run.id, leaseOwner, `Discovery failed: ${errorName(error)}`)
        .catch(() => undefined);
      throw error;
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async currentResult(runId: string, campaignId: string): Promise<unknown> {
    const current = (await this.stageRuns.get(runId)) as StageRunRecord;
    if (current.status === "SUCCEEDED") return current.result;
    if (current.status === "RUNNING" || current.status === "PENDING") {
      const inProgress: DiscoveryInProgress = {
        status: "IN_PROGRESS",
        campaignId,
        stageRunId: runId,
      };
      return inProgress;
    }
    throw new ConflictException(`Discovery stage ended as ${current.status}`);
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
