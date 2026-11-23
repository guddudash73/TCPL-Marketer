import { Inject, Injectable, Logger } from "@nestjs/common";
import type { Prisma } from "@tcpl-marketer/database";

import { DatabaseService } from "../database/database.service.js";
import { AUDIT_EVENTS, type AuditAction, type AuditEntry } from "./audit-events.js";
import { buildAuditRow } from "./audit-row.js";

/** Anything that can write audit rows: the shared client or a transaction. */
export type AuditClient = Pick<Prisma.TransactionClient, "auditLog">;

export class AuditWriteError extends Error {
  constructor(action: string) {
    super(`The audit event ${action} could not be written`);
    this.name = "AuditWriteError";
  }
}

/**
 * The only way application code writes audit rows. It validates the event
 * against the closed catalogue, redacts the payload, attaches the correlation
 * ID and campaign, and never lets a failed write disappear silently.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  private failedWriteCount = 0;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  /** Audit writes that failed since start (non-critical events are logged, not thrown). */
  get failedWrites(): number {
    return this.failedWriteCount;
  }

  /**
   * Writes one event. Pass the transaction of the change being recorded for
   * critical events so both commit or neither does. Without a transaction a
   * critical failure still throws; a non-critical failure is logged and counted.
   */
  async record<A extends AuditAction>(
    entry: AuditEntry<A>,
    client?: AuditClient,
  ): Promise<void> {
    const data = buildAuditRow(entry);
    const definition = AUDIT_EVENTS[entry.action];
    try {
      await (client ?? this.database.client).auditLog.create({ data });
    } catch (error) {
      this.failedWriteCount += 1;
      this.logger.error({
        msg: "Audit write failed",
        action: entry.action,
        critical: definition.critical,
        correlationId: data.correlationId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      if (definition.critical) throw new AuditWriteError(entry.action);
    }
  }

  /**
   * Runs a change and its audit row in one transaction. If the audit write
   * fails the change is rolled back.
   */
  async withAudit<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
    entry: (result: T) => AuditEntry,
  ): Promise<T> {
    return this.database.client.$transaction(async (transaction) => {
      const result = await operation(transaction);
      await this.record(entry(result), transaction);
      return result;
    });
  }
}
