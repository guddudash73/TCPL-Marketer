import { Module } from "@nestjs/common";
import { CAMPAIGN_STATE_READER, ORCHESTRATION_GATEWAY } from "@tcpl-marketer/orchestration-contracts";

import { InternalOrchestrationController } from "./internal-orchestration.controller.js";
import { N8nOrchestrationAdapter } from "./n8n-orchestration.adapter.js";
import { OrchestrationService } from "./orchestration.service.js";
import { PrismaCampaignStateReader } from "./prisma-campaign-state-reader.js";
import { StageRunService } from "./stage-run.service.js";
import { ServiceAuthGuard } from "../common/service-auth.guard.js";
import { SearchModule } from "../search/search.module.js";

@Module({
  imports: [SearchModule],
  controllers: [InternalOrchestrationController],
  providers: [
    N8nOrchestrationAdapter,
    OrchestrationService,
    PrismaCampaignStateReader,
    StageRunService,
    ServiceAuthGuard,
    {
      provide: CAMPAIGN_STATE_READER,
      useExisting: PrismaCampaignStateReader,
    },
    {
      provide: ORCHESTRATION_GATEWAY,
      useExisting: N8nOrchestrationAdapter,
    },
  ],
  exports: [OrchestrationService, StageRunService],
})
export class OrchestrationModule {}
