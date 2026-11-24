import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { PIPELINE_STAGES } from "@tcpl-marketer/orchestration-contracts";
import { z } from "zod";

import { DatabaseService } from "../database/database.service.js";
import { formatMicro, parseMicro } from "./money.js";
import { PROVIDERS, type BudgetScope, type ProviderBudgetConfig, type UsageUnit } from "./provider-budget.config.js";
import { PROVIDER_BUDGET_CONFIG, ProviderUsageLedger } from "./provider-usage-ledger.service.js";

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), {
    message: "day must be a real UTC date (YYYY-MM-DD)",
  });

const filters = {
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  provider: z.enum(PROVIDERS).optional(),
  stage: z.enum(PIPELINE_STAGES).optional(),
  day: day.optional(),
  status: z.enum(["RESERVED", "SETTLED", "RELEASED", "EXPIRED"]).optional(),
};

/** The whole-system report may also be narrowed to one campaign. */
export const systemUsageQuerySchema = z.strictObject({ ...filters, campaignId: z.string().uuid().optional() });
/** The campaign report takes the campaign from the path. */
export const campaignUsageQuerySchema = z.strictObject(filters);
export type UsageQuery = z.infer<typeof systemUsageQuerySchema>;

export interface UsageWindow {
  used: string;
  cap: string | null;
  remaining: string | null;
  percent: number | null;
}

const ALERT_DAYS = 14;
const ALERT_LIMIT = 100;

function window(used: string, cap: bigint | null): UsageWindow {
  const usedMicro = parseMicro(used) ?? 0n;
  if (cap === null) return { used: formatMicro(usedMicro), cap: null, remaining: null, percent: null };
  return {
    used: formatMicro(usedMicro),
    cap: formatMicro(cap),
    remaining: formatMicro(usedMicro >= cap ? 0n : cap - usedMicro),
    percent: Number((usedMicro * 10_000n) / cap) / 100,
  };
}

const SCOPE_LABEL: Record<BudgetScope, string> = { RUN: "run", CAMPAIGN: "campaign", DAY: "daily", GLOBAL_DAY: "daily total across providers" };

/** What the owner can do about an alert. It never names a setting or a secret. */
export function alertReason(alert: {
  kind: string;
  scope: BudgetScope;
  provider: string | null;
  thresholdPercent: number | null;
  unit: UsageUnit | null;
  cap: string | null;
  used: string | null;
}): string {
  const who = alert.provider ?? "all providers";
  const amount = alert.cap ? `${alert.used ?? "0"} of ${alert.cap} ${alert.unit ?? ""}`.trim() : `${alert.used ?? "0"} ${alert.unit ?? ""}`.trim();
  const resets = alert.scope === "DAY" || alert.scope === "GLOBAL_DAY" ? " The daily budget starts again on the next UTC day." : "";
  if (alert.kind === "EXPIRED_HOLD") {
    return `A ${who} call was never settled and still counts ${amount}. Check with the provider whether it was charged, then review it.`;
  }
  if (alert.kind === "CAP_REACHED") {
    const usedMicro = alert.used === null ? null : parseMicro(alert.used);
    const capMicro = alert.cap === null ? null : parseMicro(alert.cap);
    // A call can be refused before anything is used up, because the amount it needs is more than the cap leaves.
    if (usedMicro !== null && capMicro !== null && usedMicro < capMicro) {
      return `A ${who} call was refused because the amount it needs would pass the ${SCOPE_LABEL[alert.scope]} cap (${amount} used so far); the owner can raise the cap or lower the call's size.${resets}`;
    }
    return `The ${SCOPE_LABEL[alert.scope]} budget for ${who} reached its cap (${amount}); further calls are refused until the owner raises the cap.${resets}`;
  }
  return `The ${SCOPE_LABEL[alert.scope]} budget for ${who} is ${alert.thresholdPercent ?? 0}% used (${amount}). Ask the owner to raise the cap or reduce the run.${resets}`;
}

@Injectable()
export class ProviderUsageReportService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(ProviderUsageLedger) private readonly ledger: ProviderUsageLedger,
    @Inject(PROVIDER_BUDGET_CONFIG) private readonly config: ProviderBudgetConfig,
  ) {}

  async forCampaign(campaignId: string, query: Omit<UsageQuery, "campaignId">): Promise<unknown> {
    const exists = await this.database.client.campaign.findUnique({ where: { id: campaignId }, select: { id: true } });
    if (!exists) throw new NotFoundException(`Campaign ${campaignId} was not found`);
    return this.report({ ...query, campaignId });
  }

  async forSystem(query: UsageQuery): Promise<unknown> {
    if (query.campaignId) {
      const exists = await this.database.client.campaign.findUnique({ where: { id: query.campaignId }, select: { id: true } });
      if (!exists) throw new NotFoundException(`Campaign ${query.campaignId} was not found`);
    }
    return this.report(query);
  }

  private async report(query: UsageQuery): Promise<unknown> {
    const client = this.database.client;
    const campaignId = query.campaignId ?? null;
    const runId = campaignId
      ? ((await client.outboxEvent.findUnique({ where: { idempotencyKey: `campaign-start:${campaignId}` }, select: { id: true } }))?.id ?? null)
      : null;
    const dayStart = query.day ? new Date(`${query.day}T00:00:00Z`) : null;
    const where = {
      ...(campaignId ? { campaignId } : {}),
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.stage ? { stageRun: { stage: query.stage } } : {}),
      ...(dayStart ? { usageDate: dayStart } : {}),
    };
    const [total, rows] = await Promise.all([
      client.providerUsage.count({ where }),
      client.providerUsage.findMany({
        where,
        orderBy: [{ reservedAt: "desc" }, { id: "asc" }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { stageRun: { select: { stage: true } } },
      }),
    ]);

    const totalsByProvider = await this.ledger.totals({
      ...(campaignId ? { campaignId } : {}),
      ...(query.day ? { date: query.day } : {}),
    });
    const providers = [];
    for (const name of PROVIDERS) {
      const policy = this.config.providers[name];
      const usage = await this.ledger.windowUsage(name, { runId, campaignId, day: query.day ?? null });
      const totals = totalsByProvider.find((row) => row.provider === name);
      providers.push({
        provider: name,
        unit: policy.unit,
        windows: {
          day: window(usage.day, policy.caps.day),
          ...(campaignId ? { campaign: window(usage.campaign, policy.caps.campaign) } : {}),
          ...(runId ? { run: window(usage.run, policy.caps.run) } : {}),
        },
        // An unknown cost is reported on its own and is already part of the used amounts above, never as zero.
        unknownCost: { calls: totals?.unknownCostCalls ?? 0, amount: totals?.unknownCostAmount ?? "0.000000" },
        openReservations: totals?.openReservations ?? 0,
        expiredUnsettled: totals?.expiredUnsettled ?? 0,
        calls: totals?.calls ?? 0,
        requests: totals?.requests ?? 0,
      });
    }
    const globalUsed = await this.ledger.globalDayUsedUsd(query.day ?? null);

    const effectiveDay = query.day ?? new Date().toISOString().slice(0, 10);
    const since = new Date(Date.now() - ALERT_DAYS * 86_400_000);
    const alertRows = await client.providerBudgetAlert.findMany({
      where: campaignId
        ? { OR: [{ campaignId }, { scope: { in: ["DAY", "GLOBAL_DAY"] }, windowKey: effectiveDay }] }
        : { createdAt: { gte: since } },
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      take: ALERT_LIMIT,
    });

    return {
      scope: { campaignId, runId, day: effectiveDay },
      calls: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        items: rows.map((row) => ({
          id: row.id,
          provider: row.provider,
          operation: row.operation,
          status: row.status,
          unit: row.unit,
          reservedAmount: row.reservedAmount.toFixed(6),
          actualAmount: row.actualAmount?.toFixed(6) ?? null,
          requests: row.requests,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          webSearchCalls: row.webSearchCalls,
          credits: row.credits?.toFixed(6) ?? null,
          costKnown: row.costKnown,
          outcomeCode: row.outcomeCode,
          needsReview: row.needsReview,
          campaignId: row.campaignId,
          runId: row.runId,
          stageRunId: row.stageRunId,
          stage: row.stageRun?.stage ?? null,
          usageDate: row.usageDate.toISOString().slice(0, 10),
          attempt: row.attempt,
          reservedAt: row.reservedAt.toISOString(),
          settledAt: row.settledAt?.toISOString() ?? null,
        })),
      },
      providers,
      global: { unit: "USD" as const, day: window(globalUsed, this.config.globalDayUsd) },
      alerts: alertRows.map((alert) => {
        const cap = alert.cap?.toFixed(6) ?? null;
        const used = alert.used?.toFixed(6) ?? null;
        return {
          id: alert.id,
          kind: alert.kind,
          scope: alert.scope,
          provider: alert.provider,
          campaignId: alert.campaignId,
          thresholdPercent: alert.thresholdPercent,
          createdAt: alert.createdAt.toISOString(),
          reason: alertReason({ kind: alert.kind, scope: alert.scope as BudgetScope, provider: alert.provider, thresholdPercent: alert.thresholdPercent, unit: alert.unit, cap, used }),
        };
      }),
    };
  }
}
