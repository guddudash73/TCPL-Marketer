import {
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";

import { Public } from "../auth/public.decorator.js";
import { campaignIdSchema } from "../campaigns/campaign.schemas.js";
import { ServiceAuthGuard } from "../common/service-auth.guard.js";
import { RequiresServiceScope } from "../common/service-auth/service-scope.decorator.js";
import {
  DiscoveryStageService,
  isDiscoveryInProgress,
} from "./discovery-stage.service.js";
import { OrchestrationService } from "./orchestration.service.js";

@Controller("internal/campaigns")
@Public()
@UseGuards(ServiceAuthGuard)
export class InternalOrchestrationController {
  constructor(
    @Inject(OrchestrationService)
    private readonly orchestration: OrchestrationService,
    @Inject(DiscoveryStageService)
    private readonly discovery: DiscoveryStageService,
  ) {}

  @Get(":id/context")
  @RequiresServiceScope("campaign.context.read")
  getCampaignContext(
    @Param("id", { schema: campaignIdSchema }) id: string,
  ): Promise<unknown> {
    return this.orchestration.getCampaignContext(id);
  }

  @Post(":id/prepare-discovery")
  @RequiresServiceScope("campaign.discovery.prepare")
  async prepareDiscovery(
    @Param("id", { schema: campaignIdSchema }) id: string,
    @Res({ passthrough: true }) response: { status(code: number): unknown },
  ): Promise<unknown> {
    const result = await this.discovery.run(id);
    if (isDiscoveryInProgress(result)) response.status(202);
    return result;
  }
}
