import { Module } from "@nestjs/common";
import { CLAIM_EXTRACTOR } from "@tcpl-marketer/provider-contracts";
import OpenAI from "openai";

import { ServiceAuthGuard } from "../common/service-auth.guard.js";
import { ClaimExtractionService } from "./claim-extraction.service.js";
import { InternalCompanyIntelligenceController } from "./internal-company-intelligence.controller.js";
import {
  OPENAI_CLAIM_CLIENT,
  OpenAIClaimExtractionAdapter,
} from "./openai-claim-extraction.adapter.js";

@Module({
  controllers: [InternalCompanyIntelligenceController],
  providers: [
    ClaimExtractionService,
    OpenAIClaimExtractionAdapter,
    ServiceAuthGuard,
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
  exports: [ClaimExtractionService],
})
export class CompanyIntelligenceModule {}
