import { Module } from "@nestjs/common";

import { PeoplePersistenceService } from "./people-persistence.service.js";

@Module({
  providers: [PeoplePersistenceService],
  exports: [PeoplePersistenceService],
})
export class PeopleModule {}
