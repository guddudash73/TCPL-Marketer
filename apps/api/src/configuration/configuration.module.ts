import { Module } from "@nestjs/common";

import { AuditModule } from "../audit/audit.module.js";
import { CapabilitiesController } from "./controllers/capabilities.controller.js";
import { DecisionMakersController } from "./controllers/decision-makers.controller.js";
import { DeliverablesController } from "./controllers/deliverables.controller.js";
import { SectorsController } from "./controllers/sectors.controller.js";
import { TargetProfilesController } from "./controllers/target-profiles.controller.js";
import { ConfigurationService } from "./configuration.service.js";

@Module({
  imports: [AuditModule],
  controllers: [
    SectorsController,
    CapabilitiesController,
    DeliverablesController,
    TargetProfilesController,
    DecisionMakersController,
  ],
  providers: [ConfigurationService],
})
export class ConfigurationModule {}
