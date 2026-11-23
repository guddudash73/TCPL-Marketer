import { Inject, Injectable } from "@nestjs/common";
import type { CampaignStateReader } from "@tcpl-marketer/orchestration-contracts";

import { DatabaseService } from "../database/database.service.js";

/** Campaign states in which pipeline work may be dispatched. PH1-05 adds pause and stop semantics. */
const DISPATCHABLE_STATES = ["STARTING", "RUNNING"] as const;

@Injectable()
export class PrismaCampaignStateReader implements CampaignStateReader {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async isDispatchable(campaignId: string): Promise<boolean> {
    const campaign = await this.database.client.campaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });
    if (!campaign) return false;
    return (DISPATCHABLE_STATES as readonly string[]).includes(campaign.status);
  }
}
