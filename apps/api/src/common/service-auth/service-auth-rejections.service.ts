import { Inject, Injectable, Logger } from "@nestjs/common";

import { AuditService } from "../../audit/audit.service.js";
import { currentCorrelationId } from "../correlation/correlation-context.js";

export const SERVICE_AUTH_REJECTION_REASONS = [
  "MISSING_HEADERS",
  "MALFORMED_HEADERS",
  "UNKNOWN_CALLER",
  "EXPIRED_TIMESTAMP",
  "FUTURE_TIMESTAMP",
  "UNVERIFIABLE_BODY",
  "BAD_SIGNATURE",
  "WRONG_SCOPE",
  "REPLAYED",
  "NO_ROUTE_SCOPE",
  "REPLAY_STORE_UNAVAILABLE",
] as const;

export type ServiceAuthRejectionReason = (typeof SERVICE_AUTH_REJECTION_REASONS)[number];

export interface ServiceAuthRejection {
  reason: ServiceAuthRejectionReason;
  /** A registered caller ID, or "unknown". Never the raw header value. */
  caller: string;
  scope: string | null;
  method: string;
  /** Request URL; the query string is dropped before storing. */
  url: string;
}

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
export const MAX_REJECTION_ROWS_PER_MINUTE = 20;
export const MAX_REJECTION_ROWS_PER_DAY = 2_000;

/**
 * Caps how many rows rejected requests can write, so a flood from an
 * unauthenticated client cannot fill the audit table. Suppressed rejections are
 * counted and reported on the next row that is written.
 */
export class RejectionAuditLimiter {
  private minuteStart = Number.NEGATIVE_INFINITY;
  private minuteCount = 0;
  private dayStart = Number.NEGATIVE_INFINITY;
  private dayCount = 0;
  private suppressed = 0;

  constructor(
    private readonly maxPerMinute = MAX_REJECTION_ROWS_PER_MINUTE,
    private readonly maxPerDay = MAX_REJECTION_ROWS_PER_DAY,
    private readonly now: () => number = Date.now,
  ) {}

  /** Null means do not write a row; a number is how many were suppressed before this one. */
  admit(): number | null {
    const time = this.now();
    if (time - this.minuteStart >= MINUTE_MS) {
      this.minuteStart = time;
      this.minuteCount = 0;
    }
    if (time - this.dayStart >= DAY_MS) {
      this.dayStart = time;
      this.dayCount = 0;
    }
    if (this.minuteCount >= this.maxPerMinute || this.dayCount >= this.maxPerDay) {
      this.suppressed += 1;
      return null;
    }
    this.minuteCount += 1;
    this.dayCount += 1;
    const suppressed = this.suppressed;
    this.suppressed = 0;
    return suppressed;
  }
}

@Injectable()
export class ServiceAuthRejectionsService {
  private readonly logger = new Logger(ServiceAuthRejectionsService.name);
  private readonly limiter = new RejectionAuditLimiter();

  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  /** Never throws: recording a rejection must not change the response to the caller. */
  async record(rejection: ServiceAuthRejection): Promise<void> {
    const suppressedSinceLastRow = this.limiter.admit();
    if (suppressedSinceLastRow === null) return;
    const path = (rejection.url.split("?")[0] ?? "").slice(0, 256);
    const method = rejection.method.slice(0, 16);
    this.logger.warn({
      msg: "Service request rejected",
      reason: rejection.reason,
      caller: rejection.caller,
      scope: rejection.scope,
      method,
      path,
      correlationId: currentCorrelationId(),
      suppressedSinceLastRow,
    });
    try {
      await this.audit.record({
        action: "service_auth.rejected",
        resourceId: rejection.caller,
        metadata: {
          reason: rejection.reason,
          caller: rejection.caller,
          scope: rejection.scope,
          method,
          path,
          suppressedSinceLastRow,
        },
      });
    } catch (error) {
      this.logger.error({
        msg: "Service rejection audit failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
}
