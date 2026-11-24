import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { Inject, Injectable, Logger } from "@nestjs/common";

import { currentCorrelation } from "../common/correlation/correlation-context.js";
import { ProviderBudgetError, type RefusedDecision } from "../provider-budget/provider-budget.error.js";
import { PROVIDER_CALL_GUARD, type ProviderCallGuard } from "../provider-budget/provider-call-guard.js";
import { issueProviderCallContext, type IssuedProviderCallContext } from "../provider-budget/provider-call-context.js";
import { providerHttpStatus } from "../provider-budget/provider-outcome.js";
import {
  ProviderUsageLedger,
  type BudgetAlert,
  type Reservation,
  type UsageReport,
} from "../provider-budget/provider-usage-ledger.service.js";
import { AuditService } from "./audit.service.js";

export interface ProviderCallDescriptor {
  /** Provider family, for example "openai". */
  provider: string;
  /** What was asked of it, for example "search-plan". */
  operation: string;
  campaignId?: string | undefined;
  /** Campaign run the spend counts toward; the ledger treats a missing run as no run cap. */
  runId?: string | undefined;
  stageRunId?: string | undefined;
  /**
   * Idempotency key. When omitted, a call inside a stage run gets the key
   * stage run + attempt + operation (duplicate delivery inside one attempt reserves once, a retried
   * attempt is a new reservation); a call outside a stage run gets a unique key.
   */
  callKey?: string | undefined;
}

/** The parts of a normalized provider result that an audit row and a usage report record. */
interface ProviderRunLike {
  model?: unknown;
  providerResponseId?: unknown;
  usage?: {
    inputTokens?: unknown;
    outputTokens?: unknown;
    credits?: unknown;
    requests?: unknown;
    webSearchCalls?: unknown;
  } | null;
}

/**
 * The one place a provider call is wrapped (PH1-02a, PH1-03a). Before the call
 * it reserves budget in the usage ledger, afterwards it settles the real usage
 * (or releases the reservation when the provider was provably not reached), and
 * it leaves an audit row. PH1-03b makes this the mandatory boundary for every
 * provider adapter.
 * The audit row never contains the request, the response body or any credential.
 */
@Injectable()
export class ProviderCallAuditor {
  private readonly logger = new Logger(ProviderCallAuditor.name);

  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(ProviderUsageLedger) private readonly ledger: ProviderUsageLedger,
    @Inject(PROVIDER_CALL_GUARD) private readonly guard: ProviderCallGuard,
  ) {}

  async run<T>(call: ProviderCallDescriptor, work: (context: IssuedProviderCallContext) => Promise<T>): Promise<T> {
    const trace = currentCorrelation();
    const campaignId = call.campaignId ?? trace?.campaignId;
    const stageRunId = call.stageRunId ?? trace?.stageRunId;
    const attempt = trace?.stageAttempt;
    const callKey =
      call.callKey ??
      (stageRunId && attempt !== undefined
        ? `${stageRunId}:a${attempt}:${call.operation}`
        : `${stageRunId ?? "adhoc"}:${call.operation}:${randomUUID()}`);

    // The campaign must still accept provider work before any budget is reserved.
    const notActive = campaignId ? await this.guard.check(campaignId) : null;
    if (notActive) {
      await this.recordRefusal({ ...call, campaignId }, notActive);
      throw new ProviderBudgetError(call.provider, call.operation, notActive);
    }

    const decision = await this.ledger.reserve({
      provider: call.provider,
      operation: call.operation,
      callKey,
      campaignId,
      runId: call.runId,
      stageRunId,
    });
    // Alerts are returned only to the call that raised them, so each one is audited exactly once.
    if ("alerts" in decision && decision.alerts?.length) await this.recordAlerts(call, decision.alerts);
    if (decision.status !== "RESERVED") {
      await this.recordRefusal(call, decision);
      throw new ProviderBudgetError(call.provider, call.operation, decision);
    }
    const reservation = decision.reservation;

    const started = performance.now();
    const context = issueProviderCallContext(call.provider, call.operation);
    let result: T;
    try {
      result = await work(context);
    } catch (error) {
      await this.settleFailure(reservation, error);
      await this.record(call, "FAILED", started, {
        errorName: error instanceof Error ? error.name.slice(0, 128) : "UnknownError",
      });
      throw error;
    }
    await this.settleSuccess(reservation, result, context.requests);
    await this.record(call, "SUCCEEDED", started, describe(result));
    return result;
  }

  private async settleSuccess(reservation: Reservation, result: unknown, countedRequests: number): Promise<void> {
    try {
      const report = usageReport(result);
      // Requests an adapter counted itself (crawl fetches) are used when the result does not report them.
      if (report.requests === undefined && countedRequests > 0) report.requests = countedRequests;
      await this.ledger.settle(reservation.id, report);
    } catch {
      // The call succeeded and its data is valid, so it must not fail now. The
      // reservation stays counted and expires into the operator review list.
      this.logger.warn(`Usage settlement failed for reservation ${reservation.id}; it will expire counted`);
    }
  }

  /**
   * A provider that answered with a client error (including rate limiting) did
   * not do paid work, so the reservation is released. Anything else, such as a
   * timeout or a server error, may have been charged: it settles at the
   * estimate with an unknown cost rather than being treated as free.
   */
  private async settleFailure(reservation: Reservation, error: unknown): Promise<void> {
    try {
      if (rejectedBeforeWork(error)) {
        await this.ledger.release(reservation.id, "PROVIDER_REJECTED");
      } else {
        await this.ledger.settle(reservation.id, { outcomeCode: "FAILED_COST_UNKNOWN" });
      }
    } catch {
      this.logger.warn(`Usage settlement failed for reservation ${reservation.id}; it will expire counted`);
    }
  }

  private async recordAlerts(call: ProviderCallDescriptor, alerts: BudgetAlert[]): Promise<void> {
    for (const alert of alerts) {
      try {
        await this.audit.record({
          action: "provider.budget_alert",
          resourceId: alert.provider ?? call.provider,
          campaignId: alert.campaignId ?? call.campaignId,
          metadata: {
            kind: alert.kind,
            scope: alert.scope,
            windowKey: alert.windowKey,
            ...(alert.thresholdPercent !== null ? { thresholdPercent: alert.thresholdPercent } : {}),
            ...(alert.unit ? { unit: alert.unit } : {}),
            ...(alert.cap ? { cap: alert.cap } : {}),
            ...(alert.used ? { used: alert.used } : {}),
          },
        });
      } catch {
        // The alert row is stored and appears in the usage report; a failed audit write must not fail the call.
        this.logger.warn(`Budget alert ${alert.id} was stored but its audit row could not be written`);
      }
    }
  }

  private async recordRefusal(
    call: ProviderCallDescriptor,
    decision: RefusedDecision,
  ): Promise<void> {
    const metadata: {
      operation: string;
      decision: typeof decision.status;
      scope?: "RUN" | "CAMPAIGN" | "DAY" | "GLOBAL_DAY";
      unit?: "USD" | "CREDITS" | "REQUESTS";
      cap?: string;
      used?: string;
      requested?: string;
      limit?: "REQUESTS_PER_MINUTE" | "CONCURRENCY";
      retryAfterSeconds?: number;
      campaignState?: string;
    } = { operation: call.operation.slice(0, 500), decision: decision.status };
    if (decision.status === "BUDGET_EXCEEDED") {
      metadata.scope = decision.scope;
      metadata.unit = decision.unit;
      metadata.cap = decision.cap;
      metadata.used = decision.used;
      metadata.requested = decision.requested;
    } else if (decision.status === "RATE_LIMITED") {
      metadata.limit = decision.limit;
      metadata.retryAfterSeconds = decision.retryAfterSeconds;
    } else if (decision.status === "CAMPAIGN_NOT_ACTIVE") {
      metadata.campaignState = decision.campaignState;
    }
    await this.audit.record({
      action: "provider.budget_refused",
      resourceId: call.provider,
      campaignId: call.campaignId,
      metadata,
    });
  }

  private async record(
    call: ProviderCallDescriptor,
    status: "SUCCEEDED" | "FAILED",
    started: number,
    details: Record<string, string | number>,
  ): Promise<void> {
    await this.audit.record({
      action: "provider.call",
      resourceId: call.provider,
      campaignId: call.campaignId,
      metadata: {
        operation: call.operation.slice(0, 500),
        status,
        durationMs: Math.max(0, Math.round(performance.now() - started)),
        ...details,
      },
    });
  }
}

/** The provider's own client-error answer (including 429 and 402), looked up through any adapter wrapper. */
function rejectedBeforeWork(error: unknown): boolean {
  const status = providerHttpStatus(error);
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function usageReport(result: unknown): UsageReport {
  const run = (typeof result === "object" && result !== null ? result : {}) as ProviderRunLike;
  const usage = run.usage;
  const report: UsageReport = {};
  const input = count(usage?.inputTokens);
  const output = count(usage?.outputTokens);
  const requests = count(usage?.requests);
  if (input !== undefined) report.inputTokens = input;
  if (output !== undefined) report.outputTokens = output;
  if (requests !== undefined) report.requests = requests;
  const searches = count(usage?.webSearchCalls);
  if (searches !== undefined) report.webSearchCalls = searches;
  const credits = usage?.credits;
  if (typeof credits === "number" || typeof credits === "string") report.credits = credits;
  return report;
}

function describe(result: unknown): Record<string, string | number> {
  const run = (typeof result === "object" && result !== null ? result : {}) as ProviderRunLike;
  const details: Record<string, string | number> = {};
  if (typeof run.model === "string") details.model = run.model.slice(0, 128);
  if (typeof run.providerResponseId === "string") {
    details.providerResponseId = run.providerResponseId.slice(0, 255);
  }
  const input = count(run.usage?.inputTokens);
  const output = count(run.usage?.outputTokens);
  if (input !== undefined) details.inputTokens = input;
  if (output !== undefined) details.outputTokens = output;
  return details;
}
