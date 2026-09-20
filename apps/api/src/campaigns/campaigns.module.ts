import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module.js";
import { OrchestrationModule } from "../orchestration/orchestration.module.js";
import { CampaignsController } from "./campaigns.controller.js";
import { CampaignsService } from "./campaigns.service.js";

@Module({
  imports: [AuditModule, OrchestrationModule],
  controllers: [CampaignsController],
  providers: [CampaignsService],
})
export class CampaignsModule {}
