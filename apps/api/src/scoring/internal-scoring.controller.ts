import { Controller, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";

import { Public } from "../auth/public.decorator.js";
import { ServiceAuthGuard } from "../common/service-auth.guard.js";
import { OpportunityScoringPersistenceService } from "./opportunity-scoring-persistence.service.js";

const candidateIdSchema = z.string().uuid();

@Controller("internal/lead-candidates")
@Public()
@UseGuards(ServiceAuthGuard)
export class InternalScoringController {
  constructor(
    @Inject(OpportunityScoringPersistenceService)
    private readonly scoring: OpportunityScoringPersistenceService,
  ) {}

  @Post(":id/score")
  score(@Param("id", { schema: candidateIdSchema }) id: string): Promise<unknown> {
    return this.scoring.scoreLeadCandidate(id);
  }

  @Get(":id/score")
  latest(@Param("id", { schema: candidateIdSchema }) id: string): Promise<unknown> {
    return this.scoring.getLatestScore(id);
  }
}
