import { Inject, Injectable } from "@nestjs/common";
import type {
  CampaignDispatchState,
  CampaignStateReader,
} from "@tcpl-marketer/orchestration-contracts";

import { DatabaseService } from "../database/database.service.js";

/** PH1-05 builds the pause, resume and stop controls on top of this mapping. */
const DISPATCH_STATE_BY_CAMPAIGN_STATUS: Readonly<
  Record<string, CampaignDispatchState>
> = {
  STARTING: "DISPATCHABLE",
  RUNNING: "DISPATCHABLE",
  DRAFT: "HOLD",
  PAUSED: "HOLD",
  COMPLETED: "TERMINAL",
  STOPPED: "TERMINAL",
  FAILED: "TERMINAL",
};

@Injectable()
export class PrismaCampaignStateReader implements CampaignStateReader {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async isDispatchable(campaignId: string): Promise<boolean> {
    return (await this.getDispatchState(campaignId)) === "DISPATCHABLE";
  }

  async getDispatchState(campaignId: string): Promise<CampaignDispatchState> {
    const campaign = await this.database.client.campaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });
    if (!campaign) return "MISSING";
    // An unmapped future status must never be dispatched by accident.
    return DISPATCH_STATE_BY_CAMPAIGN_STATUS[campaign.status] ?? "HOLD";
  }
}
