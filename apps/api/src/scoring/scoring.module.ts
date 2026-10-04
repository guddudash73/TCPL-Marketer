import { Module } from "@nestjs/common";

import { ServiceAuthGuard } from "../common/service-auth.guard.js";
import { InternalScoringController } from "./internal-scoring.controller.js";
import { OpportunityScoringPersistenceService } from "./opportunity-scoring-persistence.service.js";

@Module({
  controllers: [InternalScoringController],
  providers: [OpportunityScoringPersistenceService, ServiceAuthGuard],
  exports: [OpportunityScoringPersistenceService],
})
export class ScoringModule {}
