import { Controller, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";

import { Public } from "../auth/public.decorator.js";
import { campaignIdSchema } from "../campaigns/campaign.schemas.js";
import { ServiceAuthGuard } from "../common/service-auth.guard.js";
import { SearchService } from "../search/search.service.js";
import { OrchestrationService } from "./orchestration.service.js";

@Controller("internal/campaigns")
@Public()
@UseGuards(ServiceAuthGuard)
export class InternalOrchestrationController {
  constructor(
    @Inject(OrchestrationService)
    private readonly orchestration: OrchestrationService,
    @Inject(SearchService) private readonly search: SearchService,
  ) {}

  @Get(":id/context")
  getCampaignContext(
    @Param("id", { schema: campaignIdSchema }) id: string,
  ): Promise<unknown> {
    return this.orchestration.getCampaignContext(id);
  }

  @Post(":id/prepare-discovery")
  prepareDiscovery(
    @Param("id", { schema: campaignIdSchema }) id: string,
  ): Promise<unknown> {
    return this.search.prepareDiscovery(id);
  }
}
