import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";

import { DatabaseService } from "../../database/database.service.js";
import { readMaxSkewSeconds, replayRetentionSeconds } from "./service-auth.config.js";

const CLEANUP_INTERVAL_MS = 60_000;
const CLEANUP_BATCH_SIZE = 1_000;
const CLEANUP_MAX_BATCHES = 5;

/** Durable record of accepted request IDs, shared by every API instance. */
@Injectable()
export class ServiceReplayStore implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ServiceReplayStore.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      this.removeExpired().catch((error: unknown) => {
        this.logger.warn({
          msg: "Service nonce cleanup failed",
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
      });
    }, CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** True for the first use of this request ID; false for a replay. Throws if storage fails. */
  async consume(callerId: string, requestId: string): Promise<boolean> {
    const rows = await this.database.client.$queryRawUnsafe<Array<{ request_id: string }>>(
      `INSERT INTO service_request_nonces (caller_id, request_id, expires_at)
       VALUES ($1, $2, now() + make_interval(secs => $3::int))
       ON CONFLICT (caller_id, request_id) DO NOTHING
       RETURNING request_id`,
      callerId,
      requestId,
      replayRetentionSeconds(readMaxSkewSeconds()),
    );
    return rows.length === 1;
  }

  /** Deletes expired rows in small batches so cleanup never holds a long lock. */
  async removeExpired(
    batchSize = CLEANUP_BATCH_SIZE,
    maxBatches = CLEANUP_MAX_BATCHES,
  ): Promise<number> {
    let removed = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const count = await this.database.client.$executeRawUnsafe(
        `WITH expired AS (
           SELECT caller_id, request_id
             FROM service_request_nonces
            WHERE expires_at < now()
            ORDER BY expires_at
            LIMIT $1
            FOR UPDATE SKIP LOCKED
         )
         DELETE FROM service_request_nonces target
          USING expired
          WHERE target.caller_id = expired.caller_id
            AND target.request_id = expired.request_id`,
        batchSize,
      );
      removed += count;
      if (count < batchSize) break;
    }
    return removed;
  }
}
