import { Inject, Injectable } from "@nestjs/common";
import type { PrismaClient } from "@tcpl-marketer/database";

import { DatabaseService } from "../database/database.service.js";
import { formatMicro, multiplyMicro, parseMicro, pricePerMillion } from "./money.js";
import {
  isProviderName,
  type BudgetScope,
  type ProviderBudgetConfig,
  type ProviderName,
  type ProviderPolicy,
  type UsageUnit,
} from "./provider-budget.config.js";

export const PROVIDER_BUDGET_CONFIG = Symbol("PROVIDER_BUDGET_CONFIG");

export interface ReserveInput {
  provider: string;
  operation: string;
  /** Idempotency key: the same key never reserves twice while a live reservation or a settlement exists. */
  callKey: string;
  campaignId?: string | null | undefined;
  /** Campaign run. Until a campaign can be restarted a run and its campaign coincide. */
  runId?: string | null | undefined;
  stageRunId?: string | null | undefined;
}

export interface Reservation {
  id: string;
  provider: ProviderName;
  operation: string;
  callKey: string;
  attempt: number;
  unit: UsageUnit;
  /** Decimal string in `unit`. */
  reservedAmount: string;
}

/** A budget alert raised by one call. It is returned only to the call that inserted it, so it is handled once. */
export interface BudgetAlert {
  id: string;
  kind: "THRESHOLD" | "CAP_REACHED" | "EXPIRED_HOLD";
  scope: BudgetScope;
  provider: string | null;
  windowKey: string;
  campaignId: string | null;
  usageId: string | null;
  thresholdPercent: number | null;
  unit: UsageUnit | null;
  cap: string | null;
  used: string | null;
}

export type ReserveDecision =
  | { status: "RESERVED"; reservation: Reservation; reused: boolean; alerts?: BudgetAlert[] }
  | { status: "ALREADY_SETTLED"; reservation: Reservation }
  | {
      status: "BUDGET_EXCEEDED";
      scope: BudgetScope;
      unit: UsageUnit;
      cap: string;
      used: string;
      requested: string;
      alerts?: BudgetAlert[];
    }
  | {
      status: "RATE_LIMITED";
      limit: "REQUESTS_PER_MINUTE" | "CONCURRENCY";
      retryAfterSeconds: number;
    }
  | { status: "CAP_NOT_CONFIGURED"; provider: string; variables: string[] };

export interface UsageReport {
  /** Provider requests actually made; defaults to one. */
  requests?: number;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Billed web searches. Required to price a web-search operation; absent makes its cost unknown. Stored with the row. */
  webSearchCalls?: number | null;
  /** Apollo credits consumed, as a decimal string or number. */
  credits?: string | number | null;
  outcomeCode?: string;
}

export interface SettledUsage {
  id: string;
  status: "SETTLED";
  /** Amount now counted against the caps, in the call's unit. */
  actualAmount: string;
  costKnown: boolean;
  overrun: boolean;
}

export interface UsageTotals {
  provider: string;
  unit: UsageUnit;
  /** Everything that counts against caps: settled actuals, open reservations and expired holds. */
  counted: string;
  /** Settled amount with a known cost. */
  knownAmount: string;
  /** Amount held at the estimate because the real cost is unknown. Never reported as zero. */
  unknownCostAmount: string;
  unknownCostCalls: number;
  openReservations: number;
  expiredUnsettled: number;
  calls: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export class ProviderLedgerError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "ALREADY_RELEASED" | "ALREADY_SETTLED" | "UNKNOWN_PROVIDER",
    message: string,
  ) {
    super(message);
    this.name = "ProviderLedgerError";
  }
}

/** Serialises every reservation across all API instances. */
const LEDGER_LOCK = "tcpl:provider-usage-ledger";
const RATE_WINDOW_SECONDS = 60;
const CONCURRENCY_RETRY_SECONDS = 5;

const COUNTED =
  "CASE status WHEN 'SETTLED' THEN COALESCE(actual_amount, reserved_amount) WHEN 'RELEASED' THEN 0 ELSE reserved_amount END";
const COUNTED_USD =
  "CASE status WHEN 'SETTLED' THEN COALESCE(actual_usd, reserved_usd) WHEN 'RELEASED' THEN 0 ELSE reserved_usd END";

interface UsageRow {
  id: string;
  provider: string;
  operation: string;
  call_key: string;
  attempt: number;
  status: "RESERVED" | "SETTLED" | "RELEASED" | "EXPIRED";
  unit: UsageUnit;
  reserved_amount: string;
  reserved_usd: string;
  actual_amount: string | null;
  live: boolean;
}

@Injectable()
export class ProviderUsageLedger {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PROVIDER_BUDGET_CONFIG) private readonly config: ProviderBudgetConfig,
  ) {}

  policyFor(provider: string): ProviderPolicy {
    if (!isProviderName(provider)) {
      throw new ProviderLedgerError("UNKNOWN_PROVIDER", `Unknown provider ${provider.slice(0, 40)}`);
    }
    return this.config.providers[provider];
  }

  /** What one call is expected to cost, in the unit of its provider. */
  estimate(provider: string, operation: string): { amount: bigint; usd: bigint } {
    const policy = this.policyFor(provider);
    let amount = policy.estimatePerCall;
    if (policy.provider === "openai" && isWebSearch(operation) && policy.pricing.webSearchFeeUsd !== null) {
      amount += policy.pricing.webSearchFeeUsd;
    }
    return { amount, usd: this.toUsd(policy, amount) };
  }

  private toUsd(policy: ProviderPolicy, amount: bigint): bigint {
    if (policy.provider === "openai") return amount;
    if (policy.provider === "apollo") return multiplyMicro(amount, policy.usdPerCredit ?? 0n);
    return 0n;
  }

  async reserve(input: ReserveInput): Promise<ReserveDecision> {
    const policy = this.policyFor(input.provider);
    const missing = [...policy.missing];
    if (policy.paid && this.config.globalDayUsd === null) missing.push("BUDGET_GLOBAL_DAY_USD");
    if (policy.paid && missing.length > 0) {
      return { status: "CAP_NOT_CONFIGURED", provider: policy.provider, variables: [...new Set(missing)] };
    }

    const { amount, usd } = this.estimate(policy.provider, input.operation);
    const campaignId = input.campaignId ?? null;
    // Every call of a campaign counts toward its run cap, so a caller that does not know
    // the run gets the campaign start event, which is the run until restarts exist.
    const runId = input.runId ?? (campaignId ? await this.resolveRunId(campaignId) : null);
    const stageRunId = input.stageRunId ?? null;

    return this.database.client.$transaction(
      async (tx): Promise<ReserveDecision> => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${LEDGER_LOCK}))`;

        const alerts: BudgetAlert[] = [];

        // A reservation whose caller died keeps counting, but is flagged and no longer held "live".
        const expired = await tx.$queryRaw<ExpiredRow[]>`
          UPDATE provider_usage
             SET status = 'EXPIRED', needs_review = true, outcome_code = 'RESERVATION_EXPIRED', updated_at = now()
           WHERE provider = ${policy.provider} AND status = 'RESERVED' AND reserved_until < now()
           RETURNING id, provider, campaign_id, unit::text AS unit, reserved_amount::text AS reserved_amount`;
        for (const hold of expired) alerts.push(...(await insertAlerts(tx, [expiredHoldAlert(hold)])));

        const existing = await tx.$queryRaw<UsageRow[]>`
          SELECT id, provider, operation, call_key, attempt, status, unit,
                 reserved_amount::text AS reserved_amount, reserved_usd::text AS reserved_usd,
                 actual_amount::text AS actual_amount, (reserved_until > now()) AS live
            FROM provider_usage
           WHERE provider = ${policy.provider} AND call_key = ${input.callKey}
           ORDER BY attempt DESC LIMIT 1`;
        const latest = existing[0];
        if (latest?.status === "SETTLED") {
          return { status: "ALREADY_SETTLED", reservation: toReservation(latest) };
        }
        if (latest?.status === "RESERVED" && latest.live) {
          return { status: "RESERVED", reservation: toReservation(latest), reused: true };
        }
        const attempt = latest ? latest.attempt + 1 : 1;

        const limits = await tx.$queryRaw<Array<{ recent: bigint; active: bigint; wait: number | null }>>`
          SELECT COUNT(*) FILTER (WHERE status <> 'RELEASED' AND reserved_at > now() - make_interval(secs => ${RATE_WINDOW_SECONDS}::double precision)) AS recent,
                 COUNT(*) FILTER (WHERE status = 'RESERVED' AND reserved_until > now() AND reserved_at > now() - make_interval(secs => ${this.config.inflightSeconds}::double precision)) AS active,
                 CEIL(${RATE_WINDOW_SECONDS}::double precision - EXTRACT(EPOCH FROM (now() - MIN(reserved_at)
                   FILTER (WHERE status <> 'RELEASED' AND reserved_at > now() - make_interval(secs => ${RATE_WINDOW_SECONDS}::double precision))))) AS wait
            FROM provider_usage WHERE provider = ${policy.provider}`;
        const limit = limits[0];
        if (limit && Number(limit.recent) >= policy.requestsPerMinute) {
          return {
            status: "RATE_LIMITED",
            limit: "REQUESTS_PER_MINUTE",
            retryAfterSeconds: Math.max(1, Number(limit.wait ?? RATE_WINDOW_SECONDS)),
          };
        }
        if (limit && Number(limit.active) >= policy.maxConcurrent) {
          return { status: "RATE_LIMITED", limit: "CONCURRENCY", retryAfterSeconds: CONCURRENCY_RETRY_SECONDS };
        }

        const sums = await sumWindows(tx, policy.provider, runId, campaignId, null);
        const day = await currentUtcDay(tx);
        const scopes: Array<{ scope: BudgetScope; cap: bigint | null; used: bigint }> = [
          { scope: "RUN", cap: runId === null ? null : policy.caps.run, used: micro(sums.run_used) },
          { scope: "CAMPAIGN", cap: campaignId === null ? null : policy.caps.campaign, used: micro(sums.campaign_used) },
          { scope: "DAY", cap: policy.caps.day, used: micro(sums.day_used) },
        ];
        const windowKey = (scope: BudgetScope): string =>
          scope === "RUN" ? (runId as string) : scope === "CAMPAIGN" ? (campaignId as string) : day;
        for (const entry of scopes) {
          if (entry.cap !== null && entry.used + amount > entry.cap) {
            // Refusing a call is the moment a cap is reached: alert once for this scope and window.
            alerts.push(
              ...(await insertAlerts(tx, [
                capAlert(entry.scope, policy.provider, windowKey(entry.scope), campaignId, policy.unit, entry.cap, entry.used),
              ])),
            );
            return { ...exceeded(entry.scope, policy.unit, entry.cap, entry.used, amount), alerts } as ReserveDecision;
          }
        }

        let globalAfter: { used: bigint; cap: bigint } | null = null;
        if (this.config.globalDayUsd !== null && usd > 0n) {
          const global = await tx.$queryRawUnsafe<Array<{ used: string }>>(
            `SELECT COALESCE(SUM(${COUNTED_USD}), 0)::text AS used FROM provider_usage WHERE usage_date = (now() AT TIME ZONE 'UTC')::date`,
          );
          const globalUsed = micro(global[0]?.used);
          if (globalUsed + usd > this.config.globalDayUsd) {
            alerts.push(
              ...(await insertAlerts(tx, [capAlert("GLOBAL_DAY", null, day, null, "USD", this.config.globalDayUsd, globalUsed)])),
            );
            return { ...exceeded("GLOBAL_DAY", "USD", this.config.globalDayUsd, globalUsed, usd), alerts } as ReserveDecision;
          }
          globalAfter = { used: globalUsed + usd, cap: this.config.globalDayUsd };
        }

        const inserted = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO provider_usage
            (id, provider, operation, call_key, attempt, campaign_id, run_id, stage_run_id, usage_date,
             status, unit, reserved_amount, reserved_usd, requests, reserved_at, reserved_until, updated_at)
          VALUES
            (gen_random_uuid(), ${policy.provider}, ${input.operation.slice(0, 64)}, ${input.callKey}, ${attempt},
             ${campaignId}::uuid, ${runId}, ${stageRunId}::uuid, (now() AT TIME ZONE 'UTC')::date,
             'RESERVED', ${policy.unit}::"ProviderUsageUnit", ${formatMicro(amount)}::numeric, ${formatMicro(usd)}::numeric,
             0, now(), now() + make_interval(secs => ${this.config.reservationTtlSeconds}::double precision), now())
          RETURNING id`;
        const id = inserted[0]?.id as string;

        // After the reservation, any scope that reached the alert threshold or its cap alerts once per window.
        const percent = BigInt(this.config.alertPercent);
        const crossings: BudgetAlert[] = [];
        const after = scopes
          .filter((entry): entry is { scope: BudgetScope; cap: bigint; used: bigint } => entry.cap !== null)
          .map((entry) => ({ scope: entry.scope, provider: policy.provider as string | null, window: windowKey(entry.scope), campaign: campaignId, unit: policy.unit, cap: entry.cap, used: entry.used + amount }));
        if (globalAfter) after.push({ scope: "GLOBAL_DAY", provider: null, window: day, campaign: null, unit: "USD", cap: globalAfter.cap, used: globalAfter.used });
        for (const entry of after) {
          if (entry.used * 100n >= entry.cap * percent) {
            crossings.push(...(await insertAlerts(tx, [thresholdAlert(entry.scope, entry.provider, entry.window, entry.campaign, entry.unit, entry.cap, entry.used, this.config.alertPercent)])));
          }
          if (entry.used >= entry.cap) {
            crossings.push(...(await insertAlerts(tx, [capAlert(entry.scope, entry.provider, entry.window, entry.campaign, entry.unit, entry.cap, entry.used)])));
          }
        }
        alerts.push(...crossings);
        return {
          status: "RESERVED",
          reused: false,
          alerts,
          reservation: {
            id,
            provider: policy.provider,
            operation: input.operation.slice(0, 64),
            callKey: input.callKey,
            attempt,
            unit: policy.unit,
            reservedAmount: formatMicro(amount),
          },
        };
      },
      { timeout: 15_000, maxWait: 15_000 },
    );
  }

  private async resolveRunId(campaignId: string): Promise<string | null> {
    const start = await this.database.client.outboxEvent.findUnique({
      where: { idempotencyKey: `campaign-start:${campaignId}` },
      select: { id: true },
    });
    return start?.id ?? null;
  }

  /**
   * Replaces the estimate with what was used. When the usage or the price is
   * unknown the amount stays at the reserved estimate and the cost is flagged
   * unknown, so an unknown cost is never counted as zero.
   */
  async settle(reservationId: string, report: UsageReport = {}): Promise<SettledUsage> {
    return this.database.client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<UsageRow[]>`
        SELECT id, provider, operation, call_key, attempt, status, unit,
               reserved_amount::text AS reserved_amount, reserved_usd::text AS reserved_usd,
               actual_amount::text AS actual_amount, true AS live
          FROM provider_usage WHERE id = ${reservationId}::uuid FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new ProviderLedgerError("NOT_FOUND", "Usage reservation was not found");
      if (row.status === "RELEASED") {
        throw new ProviderLedgerError("ALREADY_RELEASED", "A released reservation cannot be settled");
      }
      if (row.status === "SETTLED") {
        return { id: row.id, status: "SETTLED" as const, actualAmount: row.actual_amount ?? row.reserved_amount, costKnown: true, overrun: false };
      }

      const policy = this.policyFor(row.provider);
      const reservedMicro = micro(row.reserved_amount);
      const reservedUsd = micro(row.reserved_usd);
      const requests = report.requests ?? 1;
      const cost = this.actualCost(policy, row.operation, report, requests);

      const actual = cost ? cost.amount : reservedMicro;
      const actualUsd = cost ? cost.usd : reservedUsd;
      const costKnown = cost !== null;
      const overrun = actual > reservedMicro;
      const credits = report.credits === undefined || report.credits === null ? null : parseMicro(String(report.credits));

      await tx.$executeRaw`
        UPDATE provider_usage
           SET status = 'SETTLED', actual_amount = ${formatMicro(actual)}::numeric, actual_usd = ${formatMicro(actualUsd)}::numeric,
               requests = ${requests}, input_tokens = ${report.inputTokens ?? null}, output_tokens = ${report.outputTokens ?? null},
               web_search_calls = ${report.webSearchCalls ?? null},
               credits = ${credits === null ? null : formatMicro(credits)}::numeric, cost_known = ${costKnown},
               outcome_code = ${(report.outcomeCode ?? (costKnown ? "OK" : "COST_UNKNOWN")).slice(0, 64)},
               needs_review = ${overrun || row.status === "EXPIRED" || !costKnown},
               settled_at = now(), updated_at = now()
         WHERE id = ${reservationId}::uuid`;
      return { id: row.id, status: "SETTLED" as const, actualAmount: formatMicro(actual), costKnown, overrun };
    });
  }

  /** Frees a reservation whose provider call provably never left this process. */
  async release(reservationId: string, outcomeCode = "NOT_REACHED"): Promise<{ status: "RELEASED" | "EXPIRED" }> {
    return this.database.client.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ status: string }>>`
        SELECT status FROM provider_usage WHERE id = ${reservationId}::uuid FOR UPDATE`;
      const row = rows[0];
      if (!row) throw new ProviderLedgerError("NOT_FOUND", "Usage reservation was not found");
      if (row.status === "SETTLED") {
        throw new ProviderLedgerError("ALREADY_SETTLED", "A settled reservation was spent and cannot be released");
      }
      // An expired hold is never silently released: the call may have been made.
      if (row.status === "EXPIRED") return { status: "EXPIRED" as const };
      if (row.status === "RESERVED") {
        await tx.$executeRaw`
          UPDATE provider_usage SET status = 'RELEASED', outcome_code = ${outcomeCode.slice(0, 64)}, updated_at = now()
           WHERE id = ${reservationId}::uuid`;
      }
      return { status: "RELEASED" as const };
    });
  }

  /** Marks reservations whose owner never settled them. They stay counted and flagged for review. */
  async expireStale(): Promise<number> {
    return this.database.client.$transaction(async (tx) => {
      const expired = await tx.$queryRaw<ExpiredRow[]>`
        UPDATE provider_usage
           SET status = 'EXPIRED', needs_review = true, outcome_code = 'RESERVATION_EXPIRED', updated_at = now()
         WHERE status = 'RESERVED' AND reserved_until < now()
         RETURNING id, provider, campaign_id, unit::text AS unit, reserved_amount::text AS reserved_amount`;
      for (const hold of expired) await insertAlerts(tx, [expiredHoldAlert(hold)]);
      return expired.length;
    });
  }

  /**
   * Used and remaining amounts per scope for one provider, for the usage report.
   * `day` is a UTC date (YYYY-MM-DD); null means today.
   */
  async windowUsage(
    provider: string,
    scope: { runId: string | null; campaignId: string | null; day: string | null },
  ): Promise<{ run: string; campaign: string; day: string }> {
    const sums = await sumWindows(this.database.client, this.policyFor(provider).provider, scope.runId, scope.campaignId, scope.day);
    return { run: sums.run_used, campaign: sums.campaign_used, day: sums.day_used };
  }

  /** Total USD counted against the global daily cap for one UTC day (null means today). */
  async globalDayUsedUsd(day: string | null): Promise<string> {
    const rows = await this.database.client.$queryRawUnsafe<Array<{ used: string }>>(
      `SELECT COALESCE(SUM(${COUNTED_USD}), 0)::numeric(20,6)::text AS used FROM provider_usage
        WHERE usage_date = COALESCE($1::date, (now() AT TIME ZONE 'UTC')::date)`,
      day,
    );
    return rows[0]?.used ?? "0.000000";
  }

  async totals(filter: { campaignId?: string; runId?: string; date?: string; provider?: string } = {}): Promise<UsageTotals[]> {
    const rows = await this.database.client.$queryRawUnsafe<
      Array<{
        provider: string;
        unit: UsageUnit;
        counted: string;
        known: string;
        unknown_amount: string;
        unknown_calls: bigint;
        open_reservations: bigint;
        expired: bigint;
        calls: bigint;
        requests: bigint;
        input_tokens: bigint;
        output_tokens: bigint;
      }>
    >(
      `SELECT provider, unit::text AS unit,
              COALESCE(SUM(${COUNTED}), 0)::numeric(20,6)::text AS counted,
              COALESCE(SUM(actual_amount) FILTER (WHERE status = 'SETTLED' AND cost_known = true), 0)::numeric(20,6)::text AS known,
              COALESCE(SUM(actual_amount) FILTER (WHERE status = 'SETTLED' AND cost_known = false), 0)::numeric(20,6)::text AS unknown_amount,
              COUNT(*) FILTER (WHERE status = 'SETTLED' AND cost_known = false) AS unknown_calls,
              COUNT(*) FILTER (WHERE status = 'RESERVED') AS open_reservations,
              COUNT(*) FILTER (WHERE status = 'EXPIRED') AS expired,
              COUNT(*) FILTER (WHERE status <> 'RELEASED') AS calls,
              COALESCE(SUM(requests), 0) AS requests,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens
         FROM provider_usage
        WHERE ($1::uuid IS NULL OR campaign_id = $1::uuid)
          AND ($2::text IS NULL OR run_id = $2::text)
          AND ($3::date IS NULL OR usage_date = $3::date)
          AND ($4::text IS NULL OR provider = $4::text)
        GROUP BY provider, unit ORDER BY provider`,
      filter.campaignId ?? null,
      filter.runId ?? null,
      filter.date ?? null,
      filter.provider ?? null,
    );
    return rows.map((row) => ({
      provider: row.provider,
      unit: row.unit,
      counted: row.counted,
      knownAmount: row.known,
      unknownCostAmount: row.unknown_amount,
      unknownCostCalls: Number(row.unknown_calls),
      openReservations: Number(row.open_reservations),
      expiredUnsettled: Number(row.expired),
      calls: Number(row.calls),
      requests: Number(row.requests),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
    }));
  }

  /** Real cost of a finished call, or null when it cannot be determined. */
  private actualCost(
    policy: ProviderPolicy,
    operation: string,
    report: UsageReport,
    requests: number,
  ): { amount: bigint; usd: bigint } | null {
    if (policy.provider === "crawl") {
      const amount = BigInt(requests) * 1_000_000n;
      return { amount, usd: 0n };
    }
    if (policy.provider === "openai") {
      const { inputPerMillionUsd, outputPerMillionUsd, webSearchFeeUsd } = policy.pricing;
      const input = report.inputTokens;
      const output = report.outputTokens;
      if (input == null || output == null || inputPerMillionUsd === null || outputPerMillionUsd === null) return null;
      let amount = pricePerMillion(input, inputPerMillionUsd) + pricePerMillion(output, outputPerMillionUsd);
      const searches = report.webSearchCalls;
      if (isWebSearch(operation) && (searches === undefined || searches === null)) return null;
      if (searches) {
        if (webSearchFeeUsd === null) return null;
        amount += webSearchFeeUsd * BigInt(searches);
      }
      return { amount, usd: amount };
    }
    // apollo
    if (report.credits === undefined || report.credits === null) return null;
    const credits = parseMicro(String(report.credits));
    if (credits === null) return null;
    return { amount: credits, usd: multiplyMicro(credits, policy.usdPerCredit ?? 0n) };
  }
}

/** Operations that use the OpenAI web search tool carry "web-search" in their name. */
function isWebSearch(operation: string): boolean {
  return operation.includes("web-search");
}

function micro(value: string | undefined): bigint {
  return value === undefined ? 0n : (parseMicro(value) ?? 0n);
}

function exceeded(scope: BudgetScope, unit: UsageUnit, cap: bigint, used: bigint, requested: bigint): ReserveDecision {
  return {
    status: "BUDGET_EXCEEDED",
    scope,
    unit,
    cap: formatMicro(cap),
    used: formatMicro(used),
    requested: formatMicro(requested),
  };
}

function toReservation(row: UsageRow): Reservation {
  return {
    id: row.id,
    provider: row.provider as ProviderName,
    operation: row.operation,
    callKey: row.call_key,
    attempt: row.attempt,
    unit: row.unit,
    reservedAmount: row.reserved_amount,
  };
}

interface ExpiredRow {
  id: string;
  provider: string;
  campaign_id: string | null;
  unit: UsageUnit;
  reserved_amount: string;
}

type SqlClient = Pick<PrismaClient, "$queryRawUnsafe" | "$queryRaw">;

/** Amounts counted against the run, campaign and day windows of one provider. */
async function sumWindows(
  client: SqlClient,
  provider: string,
  runId: string | null,
  campaignId: string | null,
  day: string | null,
): Promise<{ run_used: string; campaign_used: string; day_used: string }> {
  const rows = await client.$queryRawUnsafe<Array<{ run_used: string; campaign_used: string; day_used: string }>>(
    `SELECT COALESCE(SUM(${COUNTED}) FILTER (WHERE run_id = $2::text), 0)::text AS run_used,
            COALESCE(SUM(${COUNTED}) FILTER (WHERE campaign_id = $3::uuid), 0)::text AS campaign_used,
            COALESCE(SUM(${COUNTED}) FILTER (WHERE usage_date = COALESCE($4::date, (now() AT TIME ZONE 'UTC')::date)), 0)::text AS day_used
       FROM provider_usage
      WHERE provider = $1
        AND (usage_date = COALESCE($4::date, (now() AT TIME ZONE 'UTC')::date) OR run_id = $2::text OR campaign_id = $3::uuid)`,
    provider,
    runId,
    campaignId,
    day,
  );
  const sums = rows[0];
  return { run_used: sums?.run_used ?? "0", campaign_used: sums?.campaign_used ?? "0", day_used: sums?.day_used ?? "0" };
}

async function currentUtcDay(client: SqlClient): Promise<string> {
  const rows = await client.$queryRaw<Array<{ day: string }>>`SELECT ((now() AT TIME ZONE 'UTC')::date)::text AS day`;
  return rows[0]?.day as string;
}

interface AlertDraft {
  key: string;
  kind: BudgetAlert["kind"];
  scope: BudgetScope;
  provider: string | null;
  windowKey: string;
  campaignId: string | null;
  usageId: string | null;
  thresholdPercent: number | null;
  unit: UsageUnit | null;
  cap: bigint | null;
  used: bigint | null;
}

function scopeKey(scope: BudgetScope, provider: string | null, window: string): string {
  return `${scope}:${provider ?? "all"}:${window}`;
}

function thresholdAlert(scope: BudgetScope, provider: string | null, window: string, campaignId: string | null, unit: UsageUnit, cap: bigint, used: bigint, percent: number): AlertDraft {
  return { key: `${scopeKey(scope, provider, window)}:${percent}`, kind: "THRESHOLD", scope, provider, windowKey: window, campaignId, usageId: null, thresholdPercent: percent, unit, cap, used };
}

function capAlert(scope: BudgetScope, provider: string | null, window: string, campaignId: string | null, unit: UsageUnit, cap: bigint, used: bigint): AlertDraft {
  return { key: `${scopeKey(scope, provider, window)}:100`, kind: "CAP_REACHED", scope, provider, windowKey: window, campaignId, usageId: null, thresholdPercent: 100, unit, cap, used };
}

function expiredHoldAlert(hold: ExpiredRow): AlertDraft {
  return {
    key: `EXPIRED:${hold.id}`,
    kind: "EXPIRED_HOLD",
    scope: "DAY",
    provider: hold.provider,
    windowKey: hold.id,
    campaignId: hold.campaign_id,
    usageId: hold.id,
    thresholdPercent: null,
    unit: hold.unit,
    cap: null,
    used: micro(hold.reserved_amount),
  };
}

/** Inserts each alert once; a conflict on the key means it already fired, so it is not returned again. */
async function insertAlerts(tx: SqlClient & Pick<PrismaClient, "$executeRaw">, drafts: AlertDraft[]): Promise<BudgetAlert[]> {
  const created: BudgetAlert[] = [];
  for (const draft of drafts) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO provider_budget_alerts
        (id, alert_key, kind, scope, provider, window_key, campaign_id, usage_id, threshold_percent, unit, cap, used)
      VALUES
        (gen_random_uuid(), ${draft.key}, ${draft.kind}::"ProviderBudgetAlertKind", ${draft.scope}, ${draft.provider}, ${draft.windowKey},
         ${draft.campaignId}::uuid, ${draft.usageId}::uuid, ${draft.thresholdPercent}, ${draft.unit}::"ProviderUsageUnit",
         ${draft.cap === null ? null : formatMicro(draft.cap)}::numeric, ${draft.used === null ? null : formatMicro(draft.used)}::numeric)
      ON CONFLICT (alert_key) DO NOTHING
      RETURNING id`;
    const id = rows[0]?.id;
    if (!id) continue;
    created.push({
      id,
      kind: draft.kind,
      scope: draft.scope,
      provider: draft.provider,
      windowKey: draft.windowKey,
      campaignId: draft.campaignId,
      usageId: draft.usageId,
      thresholdPercent: draft.thresholdPercent,
      unit: draft.unit,
      cap: draft.cap === null ? null : formatMicro(draft.cap),
      used: draft.used === null ? null : formatMicro(draft.used),
    });
  }
  return created;
}
