import { Module } from "@nestjs/common";
import { ORCHESTRATION_GATEWAY } from "@tcpl-marketer/orchestration-contracts";

import { InternalOrchestrationController } from "./internal-orchestration.controller.js";
import { N8nOrchestrationAdapter } from "./n8n-orchestration.adapter.js";
import { OrchestrationService } from "./orchestration.service.js";
import { ServiceAuthGuard } from "./service-auth.guard.js";

@Module({
  controllers: [InternalOrchestrationController],
  providers: [
    N8nOrchestrationAdapter,
    OrchestrationService,
    ServiceAuthGuard,
    {
      provide: ORCHESTRATION_GATEWAY,
      useExisting: N8nOrchestrationAdapter,
    },
  ],
  exports: [OrchestrationService],
})
export class OrchestrationModule {}
