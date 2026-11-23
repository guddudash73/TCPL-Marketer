import { Module } from "@nestjs/common";
import OpenAI from "openai";

import { ServiceAuthGuard } from "../common/service-auth.guard.js";
import {
  APOLLO_FETCH,
  ApolloPeopleSearchAdapter,
} from "./apollo-people-search.adapter.js";
import { DecisionMakerAssignmentService } from "./decision-maker-assignment.service.js";
import { InternalPeopleController } from "./internal-people.controller.js";
import { PeoplePersistenceService } from "./people-persistence.service.js";
import { PeopleSelectionWorkflowService } from "./people-selection-workflow.service.js";
import {
  PUBLIC_PEOPLE_OPENAI_CLIENT,
  PublicPeopleSearchAdapter,
} from "./public-people-search.adapter.js";

@Module({
  controllers: [InternalPeopleController],
  providers: [
    PeoplePersistenceService,
    DecisionMakerAssignmentService,
    PeopleSelectionWorkflowService,
    ServiceAuthGuard,
    ApolloPeopleSearchAdapter,
    PublicPeopleSearchAdapter,
    { provide: APOLLO_FETCH, useFactory: () => globalThis.fetch },
    {
      provide: PUBLIC_PEOPLE_OPENAI_CLIENT,
      useFactory: () =>
        new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "not-configured" }),
    },
  ],
  exports: [
    PeoplePersistenceService,
    DecisionMakerAssignmentService,
    PeopleSelectionWorkflowService,
    ApolloPeopleSearchAdapter,
    PublicPeopleSearchAdapter,
  ],
})
export class PeopleModule {}
