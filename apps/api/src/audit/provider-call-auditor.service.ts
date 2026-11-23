import { performance } from "node:perf_hooks";

import { Inject, Injectable } from "@nestjs/common";

import { AuditService } from "./audit.service.js";

export interface ProviderCallDescriptor {
  /** Provider family, for example "openai". */
  provider: string;
  /** What was asked of it, for example "search-plan". */
  operation: string;
  campaignId?: string | undefined;
}

/** The parts of a normalized provider result that an audit row records. */
interface ProviderRunLike {
  model?: unknown;
  providerResponseId?: unknown;
  usage?: { inputTokens?: unknown; outputTokens?: unknown } | null;
}

/**
 * The one place a provider call is wrapped so it leaves an audit row (PH1-02a).
 * PH1-03 adds budget reservation to this same boundary, so every provider call,
 * now and in later rows, gets the audit event and the budget in one place.
 * The audit row never contains the request, the response body or any credential.
 */
@Injectable()
export class ProviderCallAuditor {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  async run<T>(call: ProviderCallDescriptor, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try {
      const result = await work();
      await this.record(call, "SUCCEEDED", started, describe(result));
      return result;
    } catch (error) {
      await this.record(call, "FAILED", started, {
        errorName: error instanceof Error ? error.name.slice(0, 128) : "UnknownError",
      });
      throw error;
    }
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

function describe(result: unknown): Record<string, string | number> {
  const run = (typeof result === "object" && result !== null ? result : {}) as ProviderRunLike;
  const details: Record<string, string | number> = {};
  if (typeof run.model === "string") details.model = run.model.slice(0, 128);
  if (typeof run.providerResponseId === "string") {
    details.providerResponseId = run.providerResponseId.slice(0, 255);
  }
  const input = run.usage?.inputTokens;
  const output = run.usage?.outputTokens;
  if (typeof input === "number" && Number.isInteger(input) && input >= 0) details.inputTokens = input;
  if (typeof output === "number" && Number.isInteger(output) && output >= 0) details.outputTokens = output;
  return details;
}
