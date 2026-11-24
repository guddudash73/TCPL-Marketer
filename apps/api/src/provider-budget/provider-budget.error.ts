import type { ReserveDecision } from "./provider-usage-ledger.service.js";

/** The campaign is paused, stopped or otherwise not accepting provider work (PH1-05 binds the lifecycle). */
export interface CampaignNotActiveDecision {
  status: "CAMPAIGN_NOT_ACTIVE";
  campaignState: string;
}

export type RefusedDecision = Exclude<ReserveDecision, { status: "RESERVED" }> | CampaignNotActiveDecision;

/**
 * A provider call that was refused before any provider was reached. It is a
 * typed outcome with a stable `code`, not an incident: the shared outcome mapper
 * (provider-outcome.ts) turns it into a stage outcome or an HTTP response.
 */
export class ProviderBudgetError extends Error {
  constructor(
    readonly provider: string,
    readonly operation: string,
    readonly decision: RefusedDecision,
  ) {
    super(describeDecision(provider, operation, decision));
    this.name = "ProviderBudgetError";
  }

  get code(): RefusedDecision["status"] {
    return this.decision.status;
  }
}

function describeDecision(provider: string, operation: string, decision: RefusedDecision): string {
  const call = `${provider} ${operation}`;
  switch (decision.status) {
    case "BUDGET_EXCEEDED":
      return `${call} refused: the ${decision.scope} budget would be exceeded (${decision.used} used of ${decision.cap} ${decision.unit})`;
    case "RATE_LIMITED":
      return `${call} refused: ${decision.limit} limit reached, retry in ${decision.retryAfterSeconds}s`;
    case "CAP_NOT_CONFIGURED":
      return `${call} refused: budget configuration is missing (${decision.variables.join(", ")})`;
    case "ALREADY_SETTLED":
      return `${call} refused: this call was already made and settled`;
    case "CAMPAIGN_NOT_ACTIVE":
      return `${call} refused: the campaign is ${decision.campaignState} and accepts no provider calls`;
  }
}
