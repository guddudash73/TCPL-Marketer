import { Module } from "@nestjs/common";
import OpenAI from "openai";

import {
  APOLLO_FETCH,
  ApolloPeopleSearchAdapter,
} from "./apollo-people-search.adapter.js";
import { PeoplePersistenceService } from "./people-persistence.service.js";
import {
  PUBLIC_PEOPLE_OPENAI_CLIENT,
  PublicPeopleSearchAdapter,
} from "./public-people-search.adapter.js";

@Module({
  providers: [
    PeoplePersistenceService,
    ApolloPeopleSearchAdapter,
    PublicPeopleSearchAdapter,
    { provide: APOLLO_FETCH, useValue: globalThis.fetch },
    {
      provide: PUBLIC_PEOPLE_OPENAI_CLIENT,
      useFactory: () =>
        new OpenAI({ apiKey: process.env.OPENAI_API_KEY ?? "not-configured" }),
    },
  ],
  exports: [
    PeoplePersistenceService,
    ApolloPeopleSearchAdapter,
    PublicPeopleSearchAdapter,
  ],
})
export class PeopleModule {}
