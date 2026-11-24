import { Module } from "@nestjs/common";

import { ProviderBudgetModule } from "../provider-budget/provider-budget.module.js";
import { AuditService } from "./audit.service.js";
import { ProviderCallAuditor } from "./provider-call-auditor.service.js";

@Module({
  imports: [ProviderBudgetModule],
  providers: [AuditService, ProviderCallAuditor],
  exports: [AuditService, ProviderCallAuditor, ProviderBudgetModule],
})
export class AuditModule {}
