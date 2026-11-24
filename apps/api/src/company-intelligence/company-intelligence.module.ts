import { Module } from "@nestjs/common";
import { CLAIM_EXTRACTOR } from "@tcpl-marketer/provider-contracts";
import OpenAI from "openai";

import { AuditModule } from "../audit/audit.module.js";
import { ClaimExtractionService } from "./claim-extraction.service.js";
import { CompanyFitEvidenceService } from "./company-fit-evidence.service.js";
import { InternalCompanyIntelligenceController } from "./internal-company-intelligence.controller.js";
import {
  OPENAI_CLAIM_CLIENT,
  OpenAIClaimExtractionAdapter,
} from "./openai-claim-extraction.adapter.js";

@Module({
  imports: [AuditModule],
  controllers: [InternalCompanyIntelligenceController],
  providers: [
    ClaimExtractionService,
    CompanyFitEvidenceService,
    OpenAIClaimExtractionAdapter,
    {
      provide: OPENAI_CLAIM_CLIENT,
      useFactory: () =>
        new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "not-configured" }),
    },
    {
      provide: CLAIM_EXTRACTOR,
      useExisting: OpenAIClaimExtractionAdapter,
    },
  ],
  exports: [ClaimExtractionService, CompanyFitEvidenceService],
})
export class CompanyIntelligenceModule {}
