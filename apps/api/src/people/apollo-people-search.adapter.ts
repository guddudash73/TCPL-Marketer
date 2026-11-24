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
  PeopleSearchRun,
  PersonCandidate,
  ProviderCallContext,
} from "@tcpl-marketer/provider-contracts";
import {
  PeopleSearchInputSchema,
  normalizePersonCandidate,
} from "@tcpl-marketer/validation";
import { z } from "zod";

import { requireProviderCallContext } from "../provider-budget/provider-call-context.js";
import { ProviderHttpError } from "../provider-budget/provider-http-error.js";

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

  async searchPeople(rawInput: PeopleSearchInput, context: ProviderCallContext): Promise<PeopleSearchRun> {
    const call = requireProviderCallContext(context, "apollo");
    const input = PeopleSearchInputSchema.parse(rawInput);
    if (!input.organization.domain) return { candidates: [], usage: null };

    const apiKey = process.env.APOLLO_API_KEY?.trim();
    if (!apiKey) {
      throw new ServiceUnavailableException("Apollo API key is not configured");
    }

    call.recordRequest();
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
      // Parse the code and the stated wait from the whole (bounded) body; only a short slice goes into the message.
      const body = (await response.text()).slice(0, 8_000);
      const detail = body.slice(0, 300);
      // Apollo documents a 429 with a retry-after header and an error_details.code in the body.
      throw new BadGatewayException(
        `Apollo People Search failed (${response.status})${detail ? `: ${detail}` : ""}`,
        { cause: new ProviderHttpError("apollo", response.status, response.headers, apolloErrorCode(body), apolloRetryAfter(body)) },
      );
    }

    const payload = ApolloPeopleSearchResponseSchema.parse(
      await response.json(),
    );
    const candidates = payload.people
      .map(mapApolloPerson)
      .filter((candidate): candidate is PersonCandidate => candidate !== null)
      .slice(0, input.maximumResults);
    // Apollo documents People API Search as 0 credits and reports no usage in the response.
    return { candidates, usage: { requests: 1, credits: 0 } };
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

/** The error_details.code of an Apollo error body, when the body is JSON and carries one. */
function apolloErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const details = typeof parsed === "object" && parsed !== null ? (parsed as { error_details?: { code?: unknown } }).error_details : undefined;
    return typeof details?.code === "string" ? details.code.slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

/** The wait Apollo states in error_details.suggestions[].retry_after_seconds (its platform-wide 429 sends no header). */
function apolloRetryAfter(body: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    const suggestions = typeof parsed === "object" && parsed !== null ? (parsed as { error_details?: { suggestions?: unknown } }).error_details?.suggestions : undefined;
    if (!Array.isArray(suggestions)) return undefined;
    for (const item of suggestions) {
      const seconds = typeof item === "object" && item !== null ? (item as { retry_after_seconds?: unknown }).retry_after_seconds : undefined;
      if (typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0) return seconds;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

