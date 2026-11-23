import { Global, Logger, Module, type OnModuleInit } from "@nestjs/common";

import { AuditModule } from "../../audit/audit.module.js";
import { ServiceAuthGuard } from "../service-auth.guard.js";
import { ServiceAuthRejectionsService } from "./service-auth-rejections.service.js";
import { validateServiceAuthEnvironment } from "./service-auth.config.js";
import { ServiceReplayStore } from "./service-replay.store.js";

@Global()
@Module({
  imports: [AuditModule],
  providers: [ServiceAuthGuard, ServiceAuthRejectionsService, ServiceReplayStore],
  exports: [ServiceAuthGuard, ServiceAuthRejectionsService, ServiceReplayStore],
})
export class ServiceAuthModule implements OnModuleInit {
  private readonly logger = new Logger(ServiceAuthModule.name);

  onModuleInit(): void {
    const { missing } = validateServiceAuthEnvironment();
    if (missing.length > 0) {
      this.logger.warn({ msg: "Service callers without a secret cannot authenticate", missing });
    }
  }
}
