import { Body, Controller, Get, Headers, Inject, Param, Post, UseGuards } from "@nestjs/common";
import {
  RecordCompanyFitEvidenceSchema,
  type RecordCompanyFitEvidenceInput,
} from "@tcpl-marketer/validation";
import { z } from "zod";

import { Public } from "../auth/public.decorator.js";
import { ServiceAuthGuard } from "../common/service-auth.guard.js";
import { RequiresServiceScope } from "../common/service-auth/service-scope.decorator.js";
import { ClaimExtractionService } from "./claim-extraction.service.js";
import { CompanyFitEvidenceService } from "./company-fit-evidence.service.js";

const organizationIdSchema = z.string().uuid();

@Controller("internal")
@Public()
@UseGuards(ServiceAuthGuard)
export class InternalCompanyIntelligenceController {
  constructor(
    @Inject(ClaimExtractionService)
    private readonly claims: ClaimExtractionService,
    @Inject(CompanyFitEvidenceService)
    private readonly companyFit: CompanyFitEvidenceService,
  ) {}

  @Post("lead-candidates/:id/research")
  @RequiresServiceScope("candidate.research.run")
  research(
    @Param("id", { schema: organizationIdSchema }) id: string,
    @Headers("x-f001-diagnostic-run-id") diagnosticRunId?: string,
    @Headers("x-f001-input-hash") inputHash?: string,
  ): Promise<unknown> {
    return this.claims.researchLeadCandidate(id, diagnosticRunId, inputHash);
  }

  @Get("organizations/:id/profile")
  @RequiresServiceScope("organization.profile.read")
  profile(
    @Param("id", { schema: organizationIdSchema }) id: string,
  ): Promise<unknown> {
    return this.claims.getCompanyProfile(id);
  }

  @Post("organizations/:id/company-fit")
  @RequiresServiceScope("organization.company_fit.write")
  recordCompanyFit(
    @Param("id", { schema: organizationIdSchema }) id: string,
    @Body({ schema: RecordCompanyFitEvidenceSchema })
    input: RecordCompanyFitEvidenceInput,
  ): Promise<unknown> {
    return this.companyFit.record(id, input);
  }

  @Get("organizations/:id/company-fit")
  @RequiresServiceScope("organization.company_fit.read")
  getCompanyFit(
    @Param("id", { schema: organizationIdSchema }) id: string,
  ): Promise<unknown> {
    return this.companyFit.getProfile(id);
  }
}
