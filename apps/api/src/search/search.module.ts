import { Module } from "@nestjs/common";
import {
  SEARCH_PLANNER,
  SEARCH_PROVIDER,
} from "@tcpl-marketer/provider-contracts";
import OpenAI from "openai";

import {
  OPENAI_CLIENT,
  OpenAISearchAdapter,
} from "./openai-search.adapter.js";
import { OrganizationResolutionService } from "./organization-resolution.service.js";
import { SearchService } from "./search.service.js";

@Module({
  providers: [
    SearchService,
    OrganizationResolutionService,
    OpenAISearchAdapter,
    {
      provide: OPENAI_CLIENT,
      useFactory: () =>
        new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "not-configured" }),
    },
    { provide: SEARCH_PLANNER, useExisting: OpenAISearchAdapter },
    { provide: SEARCH_PROVIDER, useExisting: OpenAISearchAdapter },
  ],
  exports: [SearchService, OrganizationResolutionService],
})
export class SearchModule {}
