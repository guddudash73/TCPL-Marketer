import { randomUUID } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import {
  CAMPAIGN_STATE_READER,
  ORCHESTRATION_GATEWAY,
  UnroutableOrchestrationEventError,
  type CampaignStateReader,
  type OrchestrationEvent,
  type OrchestrationGateway,
  type PublishResult,
} from "@tcpl-marketer/orchestration-contracts";

import { AuditService } from "../audit/audit.service.js";
import { runWithCorrelation, currentCorrelationId } from "../common/correlation/correlation-context.js";
import { redactString } from "../common/redaction/redactor.js";
import { DatabaseService } from "../database/database.service.js";
import {
  computeRetryDelayMs,
  readOutboxDispatchConfig,
  type OutboxDispatchConfig,
} from "./outbox-dispatch.config.js";
import { StageRunService } from "./stage-run.service.js";

const CAMPAIGN_STARTED = "CAMPAIGN_STARTED";

export interface ClaimedEvent {
  id: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  attempts: number;
  createdAt: Date | string;
  leaseOwner: string;
  correlationId: string | null;
}

export type DispatchOutcome =
  | { kind: "PUBLISHED"; eventId: string }
  | { kind: "RETRY_SCHEDULED"; eventId: string; error: string }
  | { kind: "DEAD_LETTERED"; eventId: string; reason: string }
  | { kind: "HELD"; eventId: string; reason: string }
  | { kind: "NOT_CLAIMED"; eventId: string }
  | { kind: "LEASE_LOST"; eventId: string };

export interface DispatchTickResult {
  enabled: boolean;
  reclaimedEvents: number;
  reclaimedStageRuns: number;
  claimed: number;
  published: number;
  retried: number;
  deadLettered: number;
  held: number;
  errors: number;
}

const CLAIMED_COLUMNS = `
  id,
  event_type AS "eventType",
  aggregate_type AS "aggregateType",
  aggregate_id AS "aggregateId",
  payload,
  attempts,
  created_at AS "createdAt",
  lease_owner AS "leaseOwner",
  correlation_id AS "correlationId"`;

/**
 * Publishes outbox events at least once; consumers are idempotent on the event.
 * A lease guarantees one active publisher. The publish call happens outside any
 * database transaction, and every state change is compare-and-set on the lease.
 */
@Injectable()
export class OutboxDispatcherService {
  private readonly logger = new Logger(OutboxDispatcherService.name);

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ORCHESTRATION_GATEWAY)
    private readonly gateway: OrchestrationGateway,
    @Inject(CAMPAIGN_STATE_READER)
    private readonly campaignState: CampaignStateReader,
    @Inject(StageRunService) private readonly stageRuns: StageRunService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  /** Dispatches one known event now, for example right after a user starts a campaign. */
  async dispatchEvent(
    eventId: string,
    options: { ignoreBackoff?: boolean } = {},
  ): Promise<DispatchOutcome> {
    const config = readOutboxDispatchConfig();
    await this.reclaimExpiredEvents(config, eventId);
    const rows = await this.database.client.$queryRawUnsafe<ClaimedEvent[]>(
      `UPDATE outbox_events
          SET status = 'PROCESSING'::"OutboxEventStatus",
              attempts = attempts + 1,
              lease_owner = $2,
              lease_expires_at = now() + make_interval(secs => $3::int)
        WHERE id = $1::uuid
          AND status = 'PENDING'::"OutboxEventStatus"
          AND ($4::boolean OR available_at <= now())
        RETURNING ${CLAIMED_COLUMNS}`,
      eventId,
      newLeaseOwner(),
      config.leaseSeconds,
      options.ignoreBackoff === true,
    );
    const claimed = rows[0];
    if (!claimed) return { kind: "NOT_CLAIMED", eventId };
    return this.processClaimed(claimed, config);
  }

  /** One bounded pass, called by the scheduled n8n workflow. */
  async tick(): Promise<DispatchTickResult> {
    const config = readOutboxDispatchConfig();
    const result: DispatchTickResult = {
      enabled: config.enabled,
      reclaimedEvents: 0,
      reclaimedStageRuns: 0,
      claimed: 0,
      published: 0,
      retried: 0,
      deadLettered: 0,
      held: 0,
      errors: 0,
    };
    if (!config.enabled) return result;

    result.reclaimedEvents = await this.reclaimExpiredEvents(config);
    result.reclaimedStageRuns = (
      await this.stageRuns.reclaimExpired(config.batchSize)
    ).length;

    const deadline = Date.now() + config.tickBudgetMs;
    for (let index = 0; index < config.batchSize; index += 1) {
      if (Date.now() >= deadline) break;
      const claimed = await this.claimNextDue(config);
      if (!claimed) break;
      result.claimed += 1;
      try {
        const outcome = await this.processClaimed(claimed, config);
        if (outcome.kind === "PUBLISHED") result.published += 1;
        else if (outcome.kind === "RETRY_SCHEDULED") result.retried += 1;
        else if (outcome.kind === "DEAD_LETTERED") result.deadLettered += 1;
        else if (outcome.kind === "HELD") result.held += 1;
      } catch (error) {
        // The event keeps its lease and is reclaimed after it expires.
        result.errors += 1;
        this.logger.error(
          `Dispatch of outbox event ${claimed.id} failed before it was recorded: ${errorName(error)}`,
        );
      }
    }
    return result;
  }

  async listDeadLetters(limit: number): Promise<unknown[]> {
    return this.database.client.outboxEvent.findMany({
      where: { status: "DEAD_LETTER" },
      orderBy: { deadLetteredAt: "desc" },
      take: limit,
      select: {
        id: true,
        eventType: true,
        aggregateType: true,
        aggregateId: true,
        attempts: true,
        lastError: true,
        createdAt: true,
        deadLetteredAt: true,
      },
    });
  }

  async listInFlight(limit: number): Promise<unknown[]> {
    return this.database.client.outboxEvent.findMany({
      where: { status: "PROCESSING" },
      orderBy: { leaseExpiresAt: "asc" },
      take: limit,
      select: {
        id: true,
        eventType: true,
        aggregateType: true,
        aggregateId: true,
        attempts: true,
        leaseOwner: true,
        leaseExpiresAt: true,
        createdAt: true,
      },
    });
  }

  private async claimNextDue(
    config: OutboxDispatchConfig,
  ): Promise<ClaimedEvent | undefined> {
    const rows = await this.database.client.$queryRawUnsafe<ClaimedEvent[]>(
      `UPDATE outbox_events
          SET status = 'PROCESSING'::"OutboxEventStatus",
              attempts = attempts + 1,
              lease_owner = $1,
              lease_expires_at = now() + make_interval(secs => $2::int)
        WHERE id = (
              SELECT id FROM outbox_events
               WHERE status = 'PENDING'::"OutboxEventStatus"
                 AND available_at <= now()
               ORDER BY available_at, created_at
               LIMIT 1
               FOR UPDATE SKIP LOCKED)
        RETURNING ${CLAIMED_COLUMNS}`,
      newLeaseOwner(),
      config.leaseSeconds,
    );
    return rows[0];
  }

  private processClaimed(
    event: ClaimedEvent,
    config: OutboxDispatchConfig,
  ): Promise<DispatchOutcome> {
    // The event's own trace follows it through logs, audit rows and the n8n call, including on retries.
    return runWithCorrelation(
      event.correlationId ?? currentCorrelationId() ?? randomUUID(),
      () => this.processClaimedInTrace(event, config),
      { campaignId: campaignIdOf(event) },
    );
  }

  private async processClaimedInTrace(
    event: ClaimedEvent,
    config: OutboxDispatchConfig,
  ): Promise<DispatchOutcome> {
    const campaignId = campaignIdOf(event);
    if (!campaignId) {
      return this.deadLetter(event, "Event does not identify a campaign");
    }
    const state = await this.campaignState.getDispatchState(campaignId);
    if (state === "MISSING") {
      return this.deadLetter(event, "Campaign no longer exists");
    }
    if (state === "TERMINAL") {
      return this.deadLetter(event, "Campaign has ended and will not run this event");
    }
    if (state === "HOLD") return this.hold(event, config);

    let published: PublishResult;
    try {
      published = await this.gateway.publish(toOrchestrationEvent(event));
    } catch (error) {
      const message = safeErrorMessage(error);
      if (error instanceof UnroutableOrchestrationEventError) {
        return this.deadLetter(event, message);
      }
      if (event.attempts >= config.maxAttempts) {
        return this.deadLetter(
          event,
          `Gave up after ${event.attempts} attempts: ${message}`,
        );
      }
      return this.scheduleRetry(event, message, config);
    }
    return this.acknowledge(event, published);
  }

  /** Records a successful publish. A crash before this point is safe: the event is re-published. */
  protected async acknowledge(
    event: ClaimedEvent,
    published: PublishResult,
  ): Promise<DispatchOutcome> {
    return this.database.client.$transaction(async (transaction) => {
      const now = new Date();
      const moved = await transaction.outboxEvent.updateMany({
        where: { id: event.id, status: "PROCESSING", leaseOwner: event.leaseOwner },
        data: {
          status: "PUBLISHED",
          publishedAt: now,
          lastError: null,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      if (moved.count !== 1) return { kind: "LEASE_LOST", eventId: event.id } as const;

      const automationRun = await transaction.automationRun.findUnique({
        where: { outboxEventId: event.id },
        select: { id: true },
      });
      if (automationRun) {
        await transaction.automationRun.update({
          where: { id: automationRun.id },
          data: {
            status: "RUNNING",
            attempts: event.attempts,
            externalRunId: published.externalRunId,
            startedAt: now,
            lastError: null,
          },
        });
      }
      if (event.eventType === CAMPAIGN_STARTED) {
        const started = await transaction.campaign.updateMany({
          where: { id: event.aggregateId, status: "STARTING" },
          data: { status: "RUNNING" },
        });
        if (started.count === 1) {
          const actorId = actorUserIdOf(event);
          const actor = actorId
            ? await transaction.user.findUnique({
                where: { id: actorId },
                select: { id: true },
              })
            : null;
          await this.audit.record(
            {
              action: "campaign.started",
              resourceId: event.aggregateId,
              campaignId: event.aggregateId,
              actorUserId: actor?.id ?? null,
              metadata: {
                outboxEventId: event.id,
                automationRunId: automationRun?.id ?? null,
              },
            },
            transaction,
          );
        }
      }
      return { kind: "PUBLISHED", eventId: event.id } as const;
    });
  }

  private async scheduleRetry(
    event: ClaimedEvent,
    message: string,
    config: OutboxDispatchConfig,
  ): Promise<DispatchOutcome> {
    const delayMs = computeRetryDelayMs(
      event.attempts,
      config.retryBaseMs,
      config.retryMaxMs,
    );
    return this.database.client.$transaction(async (transaction) => {
      const moved = await transaction.$executeRawUnsafe(
        `UPDATE outbox_events
            SET status = 'PENDING'::"OutboxEventStatus",
                last_error = $3,
                lease_owner = NULL,
                lease_expires_at = NULL,
                available_at = now() + make_interval(secs => $4::double precision)
          WHERE id = $1::uuid
            AND status = 'PROCESSING'::"OutboxEventStatus"
            AND lease_owner = $2`,
        event.id,
        event.leaseOwner,
        message,
        delayMs / 1_000,
      );
      if (moved !== 1) return { kind: "LEASE_LOST", eventId: event.id } as const;
      await transaction.automationRun.updateMany({
        where: { outboxEventId: event.id },
        data: { status: "FAILED", attempts: event.attempts, lastError: message },
      });
      return { kind: "RETRY_SCHEDULED", eventId: event.id, error: message } as const;
    });
  }

  /** The campaign cannot run this now but may later; the attempt is not counted. */
  private async hold(
    event: ClaimedEvent,
    config: OutboxDispatchConfig,
  ): Promise<DispatchOutcome> {
    const reason = "Held until the campaign can run again";
    const moved = await this.database.client.$executeRawUnsafe(
      `UPDATE outbox_events
          SET status = 'PENDING'::"OutboxEventStatus",
              attempts = attempts - 1,
              last_error = $3,
              lease_owner = NULL,
              lease_expires_at = NULL,
              available_at = now() + make_interval(secs => $4::int)
        WHERE id = $1::uuid
          AND status = 'PROCESSING'::"OutboxEventStatus"
          AND lease_owner = $2`,
      event.id,
      event.leaseOwner,
      reason,
      config.holdSeconds,
    );
    return moved === 1
      ? { kind: "HELD", eventId: event.id, reason }
      : { kind: "LEASE_LOST", eventId: event.id };
  }

  private async deadLetter(
    event: ClaimedEvent,
    reason: string,
  ): Promise<DispatchOutcome> {
    return this.database.client.$transaction(async (transaction) => {
      const moved = await transaction.outboxEvent.updateMany({
        where: { id: event.id, status: "PROCESSING", leaseOwner: event.leaseOwner },
        data: {
          status: "DEAD_LETTER",
          deadLetteredAt: new Date(),
          lastError: reason,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      if (moved.count !== 1) return { kind: "LEASE_LOST", eventId: event.id } as const;
      await transaction.automationRun.updateMany({
        where: { outboxEventId: event.id },
        data: { status: "FAILED", attempts: event.attempts, lastError: reason },
      });
      if (event.eventType === CAMPAIGN_STARTED) {
        await transaction.campaign.updateMany({
          where: { id: event.aggregateId, status: "STARTING" },
          data: { status: "FAILED" },
        });
      }
      await this.audit.record(
        {
          action: "orchestration.event_dead_lettered",
          resourceId: event.id,
          campaignId: campaignIdOf(event),
          metadata: {
            eventType: event.eventType,
            aggregateId: event.aggregateId,
            attempts: event.attempts,
            reason,
          },
        },
        transaction,
      );
      return { kind: "DEAD_LETTERED", eventId: event.id, reason } as const;
    });
  }

  /**
   * An expired lease means the publisher died or stalled. The event is claimed
   * for recovery: it returns to PENDING, or dead-letters at the attempt limit.
   */
  private async reclaimExpiredEvents(
    config: OutboxDispatchConfig,
    onlyEventId?: string,
  ): Promise<number> {
    const recoveryOwner = newLeaseOwner();
    const rows = await this.database.client.$queryRawUnsafe<ClaimedEvent[]>(
      `UPDATE outbox_events
          SET lease_owner = $1,
              lease_expires_at = now() + make_interval(secs => $2::int)
        WHERE id IN (
              SELECT id FROM outbox_events
               WHERE status = 'PROCESSING'::"OutboxEventStatus"
                 AND lease_expires_at < now()
                 AND ($3::uuid IS NULL OR id = $3::uuid)
               ORDER BY lease_expires_at
               LIMIT $4
               FOR UPDATE SKIP LOCKED)
        RETURNING ${CLAIMED_COLUMNS}`,
      recoveryOwner,
      config.leaseSeconds,
      onlyEventId ?? null,
      config.batchSize,
    );
    for (const event of rows) {
      if (event.attempts >= config.maxAttempts) {
        await this.deadLetter(
          event,
          `Gave up after ${event.attempts} attempts: the dispatch lease expired`,
        );
        continue;
      }
      // Due times use the database clock, so a host clock running ahead cannot delay recovery.
      await this.database.client.$executeRawUnsafe(
        `UPDATE outbox_events
            SET status = 'PENDING'::"OutboxEventStatus",
                available_at = now(),
                last_error = 'Dispatch lease expired before the publish was recorded',
                lease_owner = NULL,
                lease_expires_at = NULL
          WHERE id = $1::uuid
            AND status = 'PROCESSING'::"OutboxEventStatus"
            AND lease_owner = $2`,
        event.id,
        recoveryOwner,
      );
    }
    return rows.length;
  }
}

function newLeaseOwner(): string {
  return `dispatcher:${process.pid}:${randomUUID()}`;
}

function payloadOf(event: ClaimedEvent): Record<string, unknown> {
  const value =
    typeof event.payload === "string"
      ? (JSON.parse(event.payload) as unknown)
      : event.payload;
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function campaignIdOf(event: ClaimedEvent): string | undefined {
  if (event.aggregateType === "campaign") return event.aggregateId;
  const campaignId = payloadOf(event).campaignId;
  return typeof campaignId === "string" ? campaignId : undefined;
}

function actorUserIdOf(event: ClaimedEvent): string | undefined {
  const actor = payloadOf(event).actorUserId;
  return typeof actor === "string" ? actor : undefined;
}

function toOrchestrationEvent(event: ClaimedEvent): OrchestrationEvent {
  return {
    id: event.id,
    eventType: event.eventType,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    payload: payloadOf(event),
    createdAt: new Date(event.createdAt).toISOString(),
    correlationId: event.correlationId ?? currentCorrelationId(),
  };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return redactString(error.message).slice(0, 2_000);
  }
  return "Unknown orchestration error";
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}
