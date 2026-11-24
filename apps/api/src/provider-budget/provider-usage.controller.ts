import { Controller, Get, Inject, Param, Query } from "@nestjs/common";
import { z } from "zod";

import { Roles } from "../auth/roles.decorator.js";
import {
  ProviderUsageReportService,
  campaignUsageQuerySchema,
  systemUsageQuerySchema,
  type UsageQuery,
} from "./provider-usage-report.service.js";

const campaignIdSchema = z.string().uuid();

/**
 * Provider spend for the operator views (PH1-03d). Read only. ADMIN and MANAGER see every
 * campaign, as in the campaign API, so the object-level rule is that the campaign exists.
 * Responses hold amounts, counts and flags only: never a request body, a response body or a credential.
 */
@Controller()
@Roles("ADMIN", "MANAGER")
export class ProviderUsageController {
  constructor(@Inject(ProviderUsageReportService) private readonly report: ProviderUsageReportService) {}

  @Get("provider-usage")
  system(@Query({ schema: systemUsageQuerySchema }) query: UsageQuery): Promise<unknown> {
    return this.report.forSystem(query);
  }

  @Get("campaigns/:id/provider-usage")
  campaign(
    @Param("id", { schema: campaignIdSchema }) id: string,
    @Query({ schema: campaignUsageQuerySchema }) query: Omit<UsageQuery, "campaignId">,
  ): Promise<unknown> {
    return this.report.forCampaign(id, query);
  }
}
