import { Module } from "@nestjs/common";

import { CampaignProviderCallGuard, PROVIDER_CALL_GUARD } from "./provider-call-guard.js";
import { ProviderUsageController } from "./provider-usage.controller.js";
import { ProviderUsageReportService } from "./provider-usage-report.service.js";
import { readProviderBudgetConfig } from "./provider-budget.config.js";
import { PROVIDER_BUDGET_CONFIG, ProviderUsageLedger } from "./provider-usage-ledger.service.js";

/**
 * The factory reads and validates the environment when the application starts,
 * so a paid provider with a missing or invalid cap refuses to boot.
 */
@Module({
  controllers: [ProviderUsageController],
  providers: [
    ProviderUsageReportService,
    { provide: PROVIDER_BUDGET_CONFIG, useFactory: () => readProviderBudgetConfig(process.env) },
    ProviderUsageLedger,
    { provide: PROVIDER_CALL_GUARD, useClass: CampaignProviderCallGuard },
  ],
  exports: [ProviderUsageLedger, PROVIDER_BUDGET_CONFIG, PROVIDER_CALL_GUARD],
})
export class ProviderBudgetModule {}
