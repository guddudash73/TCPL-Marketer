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
import { classifyProviderError, stageEndFor } from "../provider-budget/provider-outcome.js";
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

    // Provider calls inside this attempt are keyed by stage run and attempt number.
    bindStageRun(run.id, claim.run.attempt);

    const heartbeat = setInterval(() => {
      void this.stageRuns
        .heartbeat(run.id, leaseOwner, stageLeaseSeconds)
        .catch(() => undefined);
    }, (stageLeaseSeconds * 1_000) / 3);
    heartbeat.unref();

    try {
      const result = await this.search.prepareDiscovery(campaignId, { runId: startEvent.id });
      await this.stageRuns.finish(run.id, {
        leaseOwner,
        actor: STAGE_DEFINITIONS.DISCOVERY.domainOwner,
        status: "SUCCEEDED",
        outcome: "DISCOVERED",
        result,
      });
      return result;
    } catch (error) {
      // An exhausted budget or provider credit is a deliberate, explained end of this stage that keeps the
      // campaign and waits for an owner, not a failure to retry. Everything else keeps the retry path below.
      const outcome = classifyProviderError(error);
      const end = outcome ? stageEndFor(outcome) : null;
      if (outcome && end) {
        const stopped = {
          status: "STOPPED",
          outcome: end.outcome,
          campaignId,
          stageRunId: run.id,
          reason: outcome.reason,
        };
        try {
          await this.stageRuns.finish(run.id, {
            leaseOwner,
            actor: STAGE_DEFINITIONS.DISCOVERY.domainOwner,
            status: end.status,
            outcome: end.outcome,
            reason: outcome.reason,
            result: stopped,
          });
          return stopped;
        } catch {
          // The lease was lost while stopping; fall through to the generic release below.
        }
      }
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
    // A stage that stopped on an exhausted budget or credit replays its explained result, so a
    // re-delivered start event finishes quietly instead of failing again.
    if (
      (current.outcome === "BUDGET_EXHAUSTED" || current.outcome === "CREDIT_EXHAUSTED") &&
      current.result !== null &&
      current.result !== undefined
    ) {
      return current.result;
    }
    throw new ConflictException(`Discovery stage ended as ${current.status}`);
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
