import { Inject, Injectable } from "@nestjs/common";
import {
  CAMPAIGN_STATE_READER,
  STAGE_DEFINITIONS,
  STAGE_RUNTIME_OWNER,
  StageTransitionError,
  requireStageTransition,
  type CampaignStateReader,
  type PipelineStage,
  type StageRunStatus,
} from "@tcpl-marketer/orchestration-contracts";

import { DatabaseService } from "../database/database.service.js";
import { computeStageInputHash } from "./stage-input-hash.js";

export interface StageRunRecord {
  id: string;
  campaignId: string;
  entityType: string;
  entityId: string;
  stage: PipelineStage;
  inputHash: string;
  status: StageRunStatus;
  attempt: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastHeartbeatAt: Date | null;
  lastError: string | null;
  outcome: string | null;
  outcomeReason: string | null;
  /** Stored output of a finished run, returned on an idempotent replay. */
  result: unknown;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface EnsureStageRunInput {
  campaignId: string;
  stage: PipelineStage;
  entityType: string;
  entityId: string;
  /** Everything the stage's result depends on; its hash is the input version. */
  input: unknown;
}

export type ClaimResult =
  | { claimed: true; run: StageRunRecord }
  | {
      claimed: false;
      reason: "CAMPAIGN_NOT_DISPATCHABLE" | "NOT_PENDING" | "NOT_FOUND";
    };

export type FinishStatus = "SUCCEEDED" | "FAILED" | "REVIEW_REQUIRED" | "SKIPPED";

export interface FinishInput {
  /** Must be the lease owner holding an unexpired lease. */
  leaseOwner: string;
  /** Must be the domain service that owns this stage. */
  actor: string;
  status: FinishStatus;
  outcome: string;
  reason?: string;
  /** JSON-serializable output kept for idempotent replays. */
  result?: unknown;
}

const RUN_COLUMNS = `
  id,
  campaign_id AS "campaignId",
  entity_type AS "entityType",
  entity_id AS "entityId",
  stage::text AS "stage",
  input_hash AS "inputHash",
  status::text AS "status",
  attempt,
  lease_owner AS "leaseOwner",
  lease_expires_at AS "leaseExpiresAt",
  last_heartbeat_at AS "lastHeartbeatAt",
  last_error AS "lastError",
  outcome,
  outcome_reason AS "outcomeReason",
  result,
  started_at AS "startedAt",
  completed_at AS "completedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"`;

const MAX_LEASE_SECONDS = 3_600;

/**
 * Durable stage run state. Every transition is validated against the shared
 * transition table and applied with compare-and-set, so concurrent callers
 * cannot both win. Time comparisons use the database clock.
 */
@Injectable()
export class StageRunService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CAMPAIGN_STATE_READER)
    private readonly campaignState: CampaignStateReader,
  ) {}

  /** Idempotent create-or-get for (entity, stage, input version). */
  async ensure(
    input: EnsureStageRunInput,
  ): Promise<{ run: StageRunRecord; created: boolean }> {
    const definition = STAGE_DEFINITIONS[input.stage];
    if (!definition) {
      throw new StageTransitionError(`Unknown stage ${String(input.stage)}`);
    }
    if (definition.entityType !== input.entityType) {
      throw new StageTransitionError(
        `Stage ${input.stage} runs against ${definition.entityType}, not ${input.entityType}`,
      );
    }
    const inputHash = computeStageInputHash(input.input);
    const key = {
      entityType_entityId_stage_inputHash: {
        entityType: input.entityType,
        entityId: input.entityId,
        stage: input.stage,
        inputHash,
      },
    };
    const existing = await this.database.client.stageRun.findUnique({ where: key });
    if (existing) return { run: existing as StageRunRecord, created: false };
    try {
      const created = await this.database.client.stageRun.create({
        data: {
          campaignId: input.campaignId,
          entityType: input.entityType,
          entityId: input.entityId,
          stage: input.stage,
          inputHash,
        },
      });
      return { run: created as StageRunRecord, created: true };
    } catch (error) {
      if (isUniqueViolation(error)) {
        const winner = await this.database.client.stageRun.findUniqueOrThrow({
          where: key,
        });
        return { run: winner as StageRunRecord, created: false };
      }
      throw error;
    }
  }

  async get(id: string): Promise<StageRunRecord | null> {
    const run = await this.database.client.stageRun.findUnique({ where: { id } });
    return (run as StageRunRecord | null) ?? null;
  }

  /** PENDING -> RUNNING under a lease. Exactly one concurrent caller can win. */
  async claim(
    runId: string,
    leaseOwner: string,
    leaseSeconds: number,
  ): Promise<ClaimResult> {
    assertLease(leaseOwner, leaseSeconds);
    const run = await this.database.client.stageRun.findUnique({
      where: { id: runId },
      select: { campaignId: true, stage: true, status: true },
    });
    if (!run) return { claimed: false, reason: "NOT_FOUND" };
    requireStageTransition(
      run.stage,
      "PENDING",
      "RUNNING",
      STAGE_RUNTIME_OWNER,
    );
    if (!(await this.campaignState.isDispatchable(run.campaignId))) {
      return { claimed: false, reason: "CAMPAIGN_NOT_DISPATCHABLE" };
    }
    const rows = await this.database.client.$queryRawUnsafe<StageRunRecord[]>(
      `UPDATE stage_runs
          SET status = 'RUNNING'::"StageRunStatus",
              attempt = attempt + 1,
              lease_owner = $2,
              lease_expires_at = now() + make_interval(secs => $3::int),
              last_heartbeat_at = now(),
              started_at = COALESCE(started_at, now()),
              last_error = NULL,
              updated_at = now()
        WHERE id = $1::uuid
          AND status = 'PENDING'::"StageRunStatus"
        RETURNING ${RUN_COLUMNS}`,
      runId,
      leaseOwner,
      leaseSeconds,
    );
    const claimed = rows[0];
    return claimed
      ? { claimed: true, run: claimed }
      : { claimed: false, reason: "NOT_PENDING" };
  }

  /** Extends a lease that is still held and unexpired. False means the lease is lost. */
  async heartbeat(
    runId: string,
    leaseOwner: string,
    leaseSeconds: number,
  ): Promise<boolean> {
    assertLease(leaseOwner, leaseSeconds);
    const rows = await this.database.client.$queryRawUnsafe<Array<{ id: string }>>(
      `UPDATE stage_runs
          SET lease_expires_at = now() + make_interval(secs => $3::int),
              last_heartbeat_at = now(),
              updated_at = now()
        WHERE id = $1::uuid
          AND status = 'RUNNING'::"StageRunStatus"
          AND lease_owner = $2
          AND lease_expires_at > now()
        RETURNING id`,
      runId,
      leaseOwner,
      leaseSeconds,
    );
    return rows.length === 1;
  }

  /** RUNNING -> terminal, by the stage's domain owner, while the caller still holds the lease. */
  async finish(runId: string, input: FinishInput): Promise<StageRunRecord> {
    const run = await this.requireRun(runId);
    requireStageTransition(run.stage, "RUNNING", input.status, input.actor);
    if (!input.outcome.trim()) {
      throw new StageTransitionError("A terminal outcome code is required");
    }
    const rows = await this.database.client.$queryRawUnsafe<StageRunRecord[]>(
      `UPDATE stage_runs
          SET status = $3::"StageRunStatus",
              outcome = $4,
              outcome_reason = $5::text,
              last_error = CASE WHEN $3::text = 'FAILED' THEN $5::text ELSE NULL END,
              result = $6::jsonb,
              lease_owner = NULL,
              lease_expires_at = NULL,
              completed_at = now(),
              updated_at = now()
        WHERE id = $1::uuid
          AND status = 'RUNNING'::"StageRunStatus"
          AND lease_owner = $2
          AND lease_expires_at > now()
        RETURNING ${RUN_COLUMNS}`,
      runId,
      input.leaseOwner,
      input.status,
      input.outcome.slice(0, 128),
      input.reason ?? null,
      input.result === undefined ? null : JSON.stringify(input.result),
    );
    const finished = rows[0];
    if (!finished) {
      throw new StageTransitionError(
        `Stage run ${runId} is not running under a valid lease held by ${input.leaseOwner}`,
      );
    }
    return finished;
  }

  /** The holder gives the run back without finishing it (RUNNING -> PENDING). */
  async release(
    runId: string,
    leaseOwner: string,
    reason: string,
  ): Promise<boolean> {
    const run = await this.requireRun(runId);
    requireStageTransition(run.stage, "RUNNING", "PENDING", STAGE_RUNTIME_OWNER);
    const rows = await this.database.client.$queryRawUnsafe<Array<{ id: string }>>(
      `UPDATE stage_runs
          SET status = 'PENDING'::"StageRunStatus",
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = $3,
              updated_at = now()
        WHERE id = $1::uuid
          AND status = 'RUNNING'::"StageRunStatus"
          AND lease_owner = $2
        RETURNING id`,
      runId,
      leaseOwner,
      reason.slice(0, 2_000),
    );
    return rows.length === 1;
  }

  /** Reclaims one run if, and only if, its lease has expired. */
  async reclaimIfExpired(runId: string): Promise<boolean> {
    const rows = await this.database.client.$queryRawUnsafe<Array<{ id: string }>>(
      `UPDATE stage_runs
          SET status = 'PENDING'::"StageRunStatus",
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = 'Lease expired before the stage run finished',
              updated_at = now()
        WHERE id = $1::uuid
          AND status = 'RUNNING'::"StageRunStatus"
          AND lease_expires_at < now()
        RETURNING id`,
      runId,
    );
    return rows.length === 1;
  }

  /** Abandoned work: RUNNING with an expired lease goes back to PENDING (stage runtime). */
  async reclaimExpired(limit = 50): Promise<StageRunRecord[]> {
    return this.database.client.$queryRawUnsafe<StageRunRecord[]>(
      `UPDATE stage_runs
          SET status = 'PENDING'::"StageRunStatus",
              lease_owner = NULL,
              lease_expires_at = NULL,
              last_error = 'Lease expired before the stage run finished',
              updated_at = now()
        WHERE id IN (
              SELECT id FROM stage_runs
               WHERE status = 'RUNNING'::"StageRunStatus"
                 AND lease_expires_at < now()
               ORDER BY lease_expires_at
               LIMIT $1
               FOR UPDATE SKIP LOCKED)
        RETURNING ${RUN_COLUMNS}`,
      limit,
    );
  }

  /** Read-only list of runs whose lease has expired. */
  async findExpired(limit = 50): Promise<StageRunRecord[]> {
    return this.database.client.$queryRawUnsafe<StageRunRecord[]>(
      `SELECT ${RUN_COLUMNS}
         FROM stage_runs
        WHERE status = 'RUNNING'::"StageRunStatus"
          AND lease_expires_at < now()
        ORDER BY lease_expires_at
        LIMIT $1`,
      limit,
    );
  }

  /**
   * Transitions owned by other services (campaign lifecycle cancel, operator
   * retry). Validated against the transition table and applied with
   * compare-and-set on the current status.
   */
  async transition(
    runId: string,
    to: StageRunStatus,
    actor: string,
    reason?: string,
  ): Promise<StageRunRecord> {
    const run = await this.requireRun(runId);
    requireStageTransition(run.stage, run.status, to, actor);
    const terminal = ["SUCCEEDED", "FAILED", "REVIEW_REQUIRED", "CANCELLED", "SKIPPED"].includes(to);
    const rows = await this.database.client.$queryRawUnsafe<StageRunRecord[]>(
      `UPDATE stage_runs
          SET status = $3::"StageRunStatus",
              lease_owner = NULL,
              lease_expires_at = NULL,
              outcome_reason = $4::text,
              completed_at = CASE WHEN $5::boolean THEN now() ELSE NULL END,
              updated_at = now()
        WHERE id = $1::uuid
          AND status = $2::"StageRunStatus"
        RETURNING ${RUN_COLUMNS}`,
      runId,
      run.status,
      to,
      reason?.slice(0, 2_000) ?? null,
      terminal,
    );
    const updated = rows[0];
    if (!updated) {
      throw new StageTransitionError(
        `Stage run ${runId} changed state while moving from ${run.status} to ${to}`,
      );
    }
    return updated;
  }

  private async requireRun(runId: string): Promise<StageRunRecord> {
    const run = await this.get(runId);
    if (!run) throw new StageTransitionError(`Stage run ${runId} was not found`);
    return run;
  }
}

function assertLease(leaseOwner: string, leaseSeconds: number): void {
  if (!leaseOwner.trim() || leaseOwner.length > 128) {
    throw new StageTransitionError("A lease owner of 1 to 128 characters is required");
  }
  if (
    !Number.isInteger(leaseSeconds) ||
    leaseSeconds < 1 ||
    leaseSeconds > MAX_LEASE_SECONDS
  ) {
    throw new StageTransitionError(
      `Lease seconds must be an integer between 1 and ${MAX_LEASE_SECONDS}`,
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}
