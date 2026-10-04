import {
  BadGatewayException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from "@nestjs/common";
import type {
  EnrichedPerson,
  PeopleProvider,
  PeopleSearchInput,
  PersonCandidate,
} from "@tcpl-marketer/provider-contracts";
import {
  PeopleSearchInputSchema,
  normalizePersonCandidate,
} from "@tcpl-marketer/validation";
import { z } from "zod";

export const APOLLO_FETCH = Symbol("APOLLO_FETCH");
export type ApolloFetch = typeof fetch;

const APOLLO_PEOPLE_SEARCH_PATH = "/api/v1/mixed_people/api_search";
const APOLLO_SENIORITIES = new Set([
  "owner",
  "founder",
  "c_suite",
  "partner",
  "vp",
  "head",
  "director",
  "manager",
  "senior",
  "entry",
  "intern",
]);

const ApolloPersonSchema = z
  .object({
    id: z.string().trim().min(1),
    first_name: z.string().trim().nullable().optional(),
    last_name: z.string().trim().nullable().optional(),
    name: z.string().trim().nullable().optional(),
    title: z.string().trim().nullable().optional(),
    seniority: z.string().trim().nullable().optional(),
    departments: z.array(z.string().trim().min(1)).optional(),
    functions: z.array(z.string().trim().min(1)).optional(),
    linkedin_url: z.string().url().nullable().optional(),
    city: z.string().trim().nullable().optional(),
    state: z.string().trim().nullable().optional(),
    country: z.string().trim().nullable().optional(),
  })
  .passthrough();

const ApolloPeopleSearchResponseSchema = z
  .object({ people: z.array(ApolloPersonSchema).default([]) })
  .passthrough();

@Injectable()
export class ApolloPeopleSearchAdapter implements PeopleProvider {
  constructor(@Inject(APOLLO_FETCH) private readonly request: ApolloFetch) {}

  async searchPeople(rawInput: PeopleSearchInput): Promise<PersonCandidate[]> {
    const input = PeopleSearchInputSchema.parse(rawInput);
    if (!input.organization.domain) return [];

    const apiKey = process.env.APOLLO_API_KEY?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException("Apollo API key is not configured");
    }

    const response = await this.request(
      `${apolloBaseUrl()}${APOLLO_PEOPLE_SEARCH_PATH}`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(buildSearchBody(input)),
        signal: AbortSignal.timeout(apolloTimeoutMilliseconds()),
      },
    );

    if (!response.ok) {
      const detail = (await response.text()).slice(0, 300);
      throw new BadGatewayException(
        `Apollo People Search failed (${response.status})${detail ? `: ${detail}` : ""}`,
      );
    }

    const payload = ApolloPeopleSearchResponseSchema.parse(
      await response.json(),
    );
    return payload.people
      .map(mapApolloPerson)
      .filter((candidate): candidate is PersonCandidate => candidate !== null)
      .slice(0, input.maximumResults);
  }

  enrichPerson(): Promise<EnrichedPerson | null> {
    return Promise.resolve(null);
  }
}

function buildSearchBody(input: PeopleSearchInput): Record<string, unknown> {
  const titles = unique(input.roles.map((role) => role.title));
  const seniorities = unique(
    input.roles.flatMap((role) =>
      role.seniorities
        .map(normalizeSeniority)
        .filter((value): value is string => value !== null),
    ),
  );
  return {
    q_organization_domains_list: [input.organization.domain],
    person_titles: titles,
    ...(seniorities.length > 0 ? { person_seniorities: seniorities } : {}),
    include_similar_titles: true,
    page: 1,
    per_page: input.maximumResults,
  };
}

function mapApolloPerson(
  person: z.infer<typeof ApolloPersonSchema>,
): PersonCandidate | null {
  const fullName =
    person.name ??
    [person.first_name, person.last_name].filter(Boolean).join(" ").trim();
  if (!fullName || !person.title) return null;

  const location = [person.city, person.state, person.country]
    .filter(Boolean)
    .join(", ");
  return normalizePersonCandidate({
    fullName,
    location: location || null,
    profileUrl: person.linkedin_url ?? null,
    source: {
      type: "PROVIDER",
      provider: "apollo",
      externalId: person.id,
      url: person.linkedin_url ?? null,
    },
    confidence: 0.8,
    role: {
      title: person.title,
      seniority: person.seniority ?? null,
      departments: unique([...(person.departments ?? []), ...(person.functions ?? [])]),
      isCurrent: true,
      sourceUrl: person.linkedin_url ?? null,
      confidence: 0.8,
    },
  });
}

function normalizeSeniority(value: string): string | null {
  const normalized = value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[\s-]+/g, "_");
  const aliases: Record<string, string> = {
    c_level: "c_suite",
    c_suite: "c_suite",
    vice_president: "vp",
  };
  const seniority = aliases[normalized] ?? normalized;
  return APOLLO_SENIORITIES.has(seniority) ? seniority : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function apolloBaseUrl(): string {
  return (process.env.APOLLO_BASE_URL ?? "https://api.apollo.io").replace(
    /\/$/,
    "",
  );
}

function apolloTimeoutMilliseconds(): number {
  const configured = Number(process.env.APOLLO_REQUEST_TIMEOUT_MS ?? 15_000);
  return Number.isFinite(configured) && configured >= 1_000
    ? Math.min(configured, 60_000)
    : 15_000;
}
