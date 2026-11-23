import { Module } from "@nestjs/common";
import { CAMPAIGN_STATE_READER, ORCHESTRATION_GATEWAY } from "@tcpl-marketer/orchestration-contracts";

import { DiscoveryStageService } from "./discovery-stage.service.js";
import { InternalOrchestrationController } from "./internal-orchestration.controller.js";
import { N8nOrchestrationAdapter } from "./n8n-orchestration.adapter.js";
import {
  InternalOutboxDispatchController,
  OutboxOperatorController,
} from "./outbox-dispatch.controller.js";
import { OutboxDispatcherService } from "./outbox-dispatcher.service.js";
import { OrchestrationService } from "./orchestration.service.js";
import { PrismaCampaignStateReader } from "./prisma-campaign-state-reader.js";
import { StageRunService } from "./stage-run.service.js";
import { ServiceAuthGuard } from "../common/service-auth.guard.js";
import { SearchModule } from "../search/search.module.js";

@Module({
  imports: [SearchModule],
  controllers: [
    InternalOrchestrationController,
    InternalOutboxDispatchController,
    OutboxOperatorController,
  ],
  providers: [
    DiscoveryStageService,
    N8nOrchestrationAdapter,
    OrchestrationService,
    OutboxDispatcherService,
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
  exports: [OrchestrationService, OutboxDispatcherService, StageRunService],
})
export class OrchestrationModule {}
