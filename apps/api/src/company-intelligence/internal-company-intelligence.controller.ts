import { Controller, Get, Inject, Param, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";

import { Public } from "../auth/public.decorator.js";
import { ServiceAuthGuard } from "../common/service-auth.guard.js";
import { ClaimExtractionService } from "./claim-extraction.service.js";

const organizationIdSchema = z.string().uuid();

@Controller("internal")
@Public()
@UseGuards(ServiceAuthGuard)
export class InternalCompanyIntelligenceController {
  constructor(
    @Inject(ClaimExtractionService)
    private readonly claims: ClaimExtractionService,
  ) {}

  @Post("lead-candidates/:id/research")
  research(
    @Param("id", { schema: organizationIdSchema }) id: string,
  ): Promise<unknown> {
    return this.claims.researchLeadCandidate(id);
  }

  @Get("organizations/:id/profile")
  profile(
    @Param("id", { schema: organizationIdSchema }) id: string,
  ): Promise<unknown> {
    return this.claims.getCompanyProfile(id);
  }
}
