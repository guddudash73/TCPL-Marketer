import { randomUUID } from "node:crypto";

import { PeopleSearchInputSchema } from "@tcpl-marketer/validation";

import { ApolloPeopleSearchAdapter } from "./apollo-people-search.adapter.js";

if (!process.env.APOLLO_API_KEY) {
  throw new Error("Set APOLLO_API_KEY before running the D016b live check");
}

const domain = process.env.APOLLO_LIVE_DOMAIN?.trim() || "apollo.io";
const title = process.env.APOLLO_LIVE_TITLE?.trim() || "Chief Executive Officer";
const adapter = new ApolloPeopleSearchAdapter(globalThis.fetch);
const candidates = await adapter.searchPeople(
  PeopleSearchInputSchema.parse({
    organization: {
      id: randomUUID(),
      name: domain,
      domain,
      location: null,
    },
    roles: [
      {
        decisionMakerProfileId: randomUUID(),
        title,
        priority: 1,
        seniorities: ["c_suite"],
        positiveTerms: [],
        negativeTerms: [],
      },
    ],
    maximumResults: 1,
  }),
);

if (candidates.length === 0) {
  throw new Error(`Apollo returned no candidates for ${title} at ${domain}`);
}

const candidate = candidates[0];
console.log(
  JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      endpoint: "/api/v1/mixed_people/api_search",
      creditClass: "0-credit People Search",
      requestedContactData: false,
      candidate: {
        fullName: candidate.fullName,
        title: candidate.role.title,
        provider: candidate.source.provider,
        providerPersonIdPresent: Boolean(candidate.source.externalId),
      },
    },
    null,
    2,
  ),
);
