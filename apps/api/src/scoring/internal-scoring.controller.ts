import { Controller, Get, Headers, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";

import { Public } from "../auth/public.decorator.js";
import { ServiceAuthGuard } from "../common/service-auth.guard.js";
import { RequiresServiceScope } from "../common/service-auth/service-scope.decorator.js";
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
  @RequiresServiceScope("candidate.score.run")
  score(
    @Param("id", { schema: candidateIdSchema }) id: string,
    @Headers("x-f001-diagnostic-run-id") diagnosticRunId?: string,
    @Headers("x-f001-input-hash") inputHash?: string,
  ): Promise<unknown> {
    return this.scoring.scoreLeadCandidate(id, diagnosticRunId, inputHash);
  }

  @Get(":id/score")
  @RequiresServiceScope("candidate.score.read")
  latest(@Param("id", { schema: candidateIdSchema }) id: string): Promise<unknown> {
    return this.scoring.getLatestScore(id);
  }
}
