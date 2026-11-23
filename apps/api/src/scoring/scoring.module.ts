import { Module } from "@nestjs/common";

import { InternalScoringController } from "./internal-scoring.controller.js";
import { OpportunityScoringPersistenceService } from "./opportunity-scoring-persistence.service.js";

@Module({
  controllers: [InternalScoringController],
  providers: [OpportunityScoringPersistenceService],
  exports: [OpportunityScoringPersistenceService],
})
export class ScoringModule {}
