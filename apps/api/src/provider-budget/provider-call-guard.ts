import { Inject, Injectable } from "@nestjs/common";

import { DatabaseService } from "../database/database.service.js";
import { PrismaCampaignStateReader } from "../orchestration/prisma-campaign-state-reader.js";
import type { CampaignNotActiveDecision } from "./provider-budget.error.js";

export const PROVIDER_CALL_GUARD = Symbol("PROVIDER_CALL_GUARD");

/**
 * The campaign-state hook of the provider gateway (PH1-03b). Before any budget is
 * reserved, the gateway asks the guard whether the campaign still accepts provider
 * work. PH1-05 binds pause, stop and cancel by changing what the campaign state
 * reader reports, so an in-flight stage that calls a provider after a stop is refused.
 */
export interface ProviderCallGuard {
  /** Null when the call may proceed, otherwise the refusal. */
  check(campaignId: string): Promise<CampaignNotActiveDecision | null>;
}

@Injectable()
export class CampaignProviderCallGuard implements ProviderCallGuard {
  private readonly reader: PrismaCampaignStateReader;

  constructor(@Inject(DatabaseService) database: DatabaseService) {
    this.reader = new PrismaCampaignStateReader(database);
  }

  async check(campaignId: string): Promise<CampaignNotActiveDecision | null> {
    const state = await this.reader.getDispatchState(campaignId);
    return state === "DISPATCHABLE" ? null : { status: "CAMPAIGN_NOT_ACTIVE", campaignState: state };
  }
}
