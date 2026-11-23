import { Module } from "@nestjs/common";

import { AuditService } from "./audit.service.js";
import { ProviderCallAuditor } from "./provider-call-auditor.service.js";

@Module({
  providers: [AuditService, ProviderCallAuditor],
  exports: [AuditService, ProviderCallAuditor],
})
export class AuditModule {}
