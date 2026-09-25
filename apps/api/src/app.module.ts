import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";

import { AdminModule } from "./admin/admin.module.js";
import { AuditModule } from "./audit/audit.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { CampaignsModule } from "./campaigns/campaigns.module.js";
import { ConfigurationModule } from "./configuration/configuration.module.js";
import { CrawlerModule } from "./crawler/crawler.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { HealthModule } from "./health/health.module.js";
import { pinoHttpOptions } from "./logging/pino-http-options.js";
import { OrchestrationModule } from "./orchestration/orchestration.module.js";
import { UsersModule } from "./users/users.module.js";

@Module({
  imports: [
    LoggerModule.forRoot({ pinoHttp: pinoHttpOptions }),
    DatabaseModule,
    AuditModule,
    UsersModule,
    AuthModule,
    CampaignsModule,
    OrchestrationModule,
    AdminModule,
    ConfigurationModule,
    CrawlerModule,
    HealthModule,
  ],
})
export class AppModule {}
