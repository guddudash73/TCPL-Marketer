import { createHash } from "node:crypto";

import {
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { Prisma } from "@tcpl-marketer/database";
import type {
  CompanyFitObservationInput,
  RecordCompanyFitEvidenceInput,
} from "@tcpl-marketer/validation";

import { DatabaseService } from "../database/database.service.js";

export const COMPANY_FIT_FACT_TYPES = [
  "HEADCOUNT",
  "GEOGRAPHY",
  "BUSINESS_MODEL",
] as const;
type FactType = (typeof COMPANY_FIT_FACT_TYPES)[number];

const observationInclude = {
  source: {
    select: {
      id: true,
      url: true,
      title: true,
      publisher: true,
      authority: true,
      publishedAt: true,
      capturedAt: true,
      contentHash: true,
    },
  },
} satisfies Prisma.CompanyFitObservationInclude;

type PersistedObservation = Prisma.CompanyFitObservationGetPayload<{
  include: typeof observationInclude;
}>;
type EvidenceSource = {
  id: string;
  capturedAt: Date;
  url: string;
  title: string | null;
  authority: string;
  webDocument: { text: string } | null;
};

@Injectable()
export class CompanyFitEvidenceService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async record(
    organizationId: string,
    input: RecordCompanyFitEvidenceInput,
  ): Promise<unknown> {
    await this.database.client.$transaction((transaction) =>
      this.recordInTransaction(transaction, organizationId, input),
    );
    return this.getProfile(organizationId);
  }

  async recordUnknowns(organizationId: string): Promise<void> {
    await this.database.client.$transaction((transaction) =>
      this.recordInTransaction(transaction, organizationId, {
        observations: COMPANY_FIT_FACT_TYPES.map((factType) => ({
          factType,
          state: "UNKNOWN" as const,
        })),
      }),
    );
  }

  async recordInTransaction(
    transaction: Prisma.TransactionClient,
    organizationId: string,
    input: RecordCompanyFitEvidenceInput,
    extractionRunId?: string,
  ): Promise<void> {
    const locked = await transaction.$queryRaw<Array<{ id: string; name: string; normalizedDomain: string | null }>>(
      Prisma.sql`SELECT "id", "name", "normalized_domain" AS "normalizedDomain" FROM "organizations" WHERE "id" = ${organizationId}::uuid FOR UPDATE`,
    );
    if (locked.length === 0) {
      throw new NotFoundException("Organization not found");
    }

    const verified = input.observations.filter(
      (observation) => observation.state === "VERIFIED",
    );
    const sourceIds = [
      ...new Set(
        verified.flatMap((observation) => [
          observation.sourceId,
          ...observation.conflictsWithSourceIds,
        ]),
      ),
    ];
    const sources = await transaction.source.findMany({
      where: { id: { in: sourceIds }, organizationId },
      select: {
        id: true,
        capturedAt: true,
        url: true,
        title: true,
        authority: true,
        webDocument: { select: { text: true } },
      },
    });
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const missingSourceId = sourceIds.find((id) => !sourceById.has(id));
    if (missingSourceId) {
      throw new UnprocessableEntityException(
        "Every company-fit observation and conflict must reference a stored source owned by the organization",
      );
    }

    for (const observation of verified) {
      if (observation.conflictsWithSourceIds.includes(observation.sourceId)) {
        throw new UnprocessableEntityException(
          "A company-fit observation cannot conflict with its own source",
        );
      }
      assertSourceSupportsObservation(
        observation,
        sourceById.get(observation.sourceId),
        locked[0]!.name,
        locked[0]!.normalizedDomain,
      );
      for (const conflictSourceId of observation.conflictsWithSourceIds) {
        const matchingInput = verified.some(
          (candidate) =>
            candidate.factType === observation.factType &&
            candidate.sourceId === conflictSourceId,
        );
        const matchingPersisted = matchingInput
          ? true
          : Boolean(
              await transaction.companyFitObservation.findFirst({
                where: {
                  organizationId,
                  factType: observation.factType,
                  sourceId: conflictSourceId,
                },
                select: { id: true },
              }),
            );
        if (!matchingPersisted) {
          throw new UnprocessableEntityException(
            "A conflicting source must support an observation of the same company-fit fact type",
          );
        }
      }
    }

    for (const observation of input.observations) {
      await this.persistObservation(
        transaction,
        organizationId,
        observation,
        sourceById,
        extractionRunId,
      );
    }
  }

  async getProfile(organizationId: string): Promise<unknown> {
    const organization = await this.database.client.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        companyFitObservations: {
          orderBy: [{ factType: "asc" }, { capturedAt: "desc" }, { id: "asc" }],
          include: observationInclude,
        },
      },
    });
    if (!organization) throw new NotFoundException("Organization not found");

    const observationsByType = new Map<FactType, PersistedObservation[]>(
      COMPANY_FIT_FACT_TYPES.map((factType) => [factType, []]),
    );
    for (const observation of organization.companyFitObservations) {
      observationsByType.get(observation.factType)?.push(observation);
    }

    return {
      organization: { id: organization.id, name: organization.name },
      facts: {
        headcount: toFact(observationsByType.get("HEADCOUNT") ?? []),
        geographies: toFact(observationsByType.get("GEOGRAPHY") ?? []),
        businessModels: toFact(
          observationsByType.get("BUSINESS_MODEL") ?? [],
        ),
      },
    };
  }

  private async persistObservation(
    transaction: Prisma.TransactionClient,
    organizationId: string,
    observation: CompanyFitObservationInput,
    sourceById: Map<string, EvidenceSource>,
    extractionRunId?: string,
  ): Promise<void> {
    const fingerprint = observationFingerprint(organizationId, observation);
    const existingFingerprint =
      await transaction.companyFitObservation.findUnique({
        where: { fingerprint },
        select: { id: true, state: true, conflictingSourceIds: true },
      });

    if (observation.state === "UNKNOWN") {
      if (existingFingerprint) {
        if (extractionRunId) {
          await transaction.companyFitObservation.update({
            where: { id: existingFingerprint.id },
            data: { extractionRunId },
          });
        }
        return;
      }
      const evidenceCount = await transaction.companyFitObservation.count({
        where: {
          organizationId,
          factType: observation.factType,
          sourceId: { not: null },
        },
      });
      if (evidenceCount === 0) {
        await transaction.companyFitObservation.create({
          data: {
            organizationId,
            factType: observation.factType,
            state: "UNKNOWN",
            extractionRunId,
            fingerprint,
          },
        });
      }
      return;
    }

    const source = sourceById.get(observation.sourceId);
    if (!source) {
      throw new UnprocessableEntityException(
        "Company-fit source was not loaded for the organization",
      );
    }

    await transaction.companyFitObservation.deleteMany({
      where: {
        organizationId,
        factType: observation.factType,
        state: "UNKNOWN",
        sourceId: null,
      },
    });

    const existing = await transaction.companyFitObservation.findMany({
      where: {
        organizationId,
        factType: observation.factType,
        sourceId: { not: null },
      },
      select: {
        id: true,
        state: true,
        sourceId: true,
        headcountMin: true,
        headcountMax: true,
        conflictingSourceIds: true,
      },
    });
    const rangeConflicts = observation.factType === "HEADCOUNT"
      ? existing.filter(
        ({ headcountMin, headcountMax }) =>
          headcountMin !== null &&
          headcountMax !== null &&
          (observation.maximum < headcountMin ||
            observation.minimum > headcountMax),
      ) : [];
    // Conflict provenance is append-only. A retry with omitted links must not
    // erase an earlier assessment. Links are scoped to this fact type.
    const conflictingSourceIds = [...new Set([
      ...(existingFingerprint?.conflictingSourceIds ?? []),
      ...observation.conflictsWithSourceIds,
      ...rangeConflicts.flatMap(({ sourceId }) => sourceId && sourceId !== observation.sourceId ? [sourceId] : []),
      ...existing.flatMap((row) => row.sourceId && row.conflictingSourceIds.includes(observation.sourceId) ? [row.sourceId] : []),
    ])];
    const conflicts =
      existingFingerprint?.state === "CONFLICT" ||
      rangeConflicts.length > 0 || conflictingSourceIds.length > 0;

    if (existingFingerprint) {
      await transaction.companyFitObservation.update({
        where: { id: existingFingerprint.id },
        data: {
          state: conflicts ? "CONFLICT" : existingFingerprint.state,
          evidenceExcerpt: observation.evidenceExcerpt,
          confidence: observation.confidence,
          conflictingSourceIds,
          ...(extractionRunId ? { extractionRunId } : {}),
        },
      });
    } else {
      await transaction.companyFitObservation.create({
        data: {
          organizationId,
          factType: observation.factType,
          state: conflicts ? "CONFLICT" : "VERIFIED",
          headcountMin:
            observation.factType === "HEADCOUNT" ? observation.minimum : null,
          headcountMax:
            observation.factType === "HEADCOUNT" ? observation.maximum : null,
          textValue:
            observation.factType === "HEADCOUNT" ? null : observation.value,
          sourceId: source.id,
          capturedAt: source.capturedAt,
          confidence: observation.confidence,
          evidenceExcerpt: observation.evidenceExcerpt,
          conflictingSourceIds,
          extractionRunId,
          fingerprint,
        },
      });
    }

    if (conflicts) {
      for (const row of existing.filter(({ sourceId }) => sourceId && conflictingSourceIds.includes(sourceId))) {
        await transaction.companyFitObservation.update({
          where: { id: row.id },
          data: {
            state: "CONFLICT",
            conflictingSourceIds: [...new Set([...row.conflictingSourceIds, observation.sourceId])],
          },
        });
      }
    }
  }
}

function assertSourceSupportsObservation(
  observation: Extract<CompanyFitObservationInput, { state: "VERIFIED" }>,
  source: EvidenceSource | undefined,
  organizationName: string,
  organizationDomain: string | null,
): void {
  const documentText = source?.webDocument?.text;
  if (!documentText) {
    throw new UnprocessableEntityException(
      "Verified company-fit evidence requires a stored source document",
    );
  }
  const normalizedDocument = normalizeText(documentText);
  const normalizedExcerpt = normalizeText(observation.evidenceExcerpt);
  const excerptOffset = normalizedDocument.indexOf(normalizedExcerpt);
  if (excerptOffset < 0) {
    throw new UnprocessableEntityException(
      "The company-fit evidence excerpt must occur in the referenced source document",
    );
  }
  const supportingSentence = sentenceContaining(
    normalizedDocument,
    excerptOffset,
    normalizedExcerpt.length,
  );
  // Qualifiers belong to the assertion, not the proper company name (for
  // example "No Limits Mapping" must not be interpreted as a negation).
  const normalizedName = normalizeText(organizationName);
  const assertion = supportingSentence.startsWith(`${normalizedName} `)
    ? supportingSentence.slice(normalizedName.length).trim()
    : supportingSentence;
  if (containsNegativeOrQualifiedAssertion(assertion)) {
    throw new UnprocessableEntityException(
      "Verified company-fit evidence must be an affirmative statement, not a negated or qualified statement",
    );
  }
  if (!assertsTargetOrganization(supportingSentence, organizationName, observation, isFirstPartySource(source, organizationDomain))) {
    throw new UnprocessableEntityException(
      "Verified company-fit evidence must attribute the fact to the target organization, not a supplier, customer, partner, affiliate, or other related company",
    );
  }

  if (observation.factType === "HEADCOUNT") {
    const statesExactCountOrRange = hasExactHeadcountExpression(
      normalizedExcerpt,
      observation.minimum,
      observation.maximum,
    );
    const namesCompanyWidePopulation =
      /\b(employee|employees|workforce|headcount|people employed)\b/.test(
        normalizedExcerpt,
      );
    if (
      !statesExactCountOrRange ||
      !namesCompanyWidePopulation ||
      isTeamOrLeadershipContext(assertion, source)
    ) {
      throw new UnprocessableEntityException(
        "Headcount evidence must directly state the company-wide employee count or range outside a team or leadership page; team-card counts are not accepted",
      );
    }
  } else if (
    !containsWholeValue(normalizedExcerpt, observation.value) ||
    !statesTextFactRelation(supportingSentence, observation.factType, observation.value)
  ) {
    throw new UnprocessableEntityException(
      "The company-fit value must be affirmed as the company's geography or business model in the source evidence excerpt",
    );
  }
}

function sentenceContaining(
  document: string,
  offset: number,
  excerptLength: number,
): string {
  const before = document.slice(0, offset);
  const lastBoundary = Math.max(
    before.lastIndexOf(". "),
    before.lastIndexOf("! "),
    before.lastIndexOf("? "),
  );
  const start = lastBoundary < 0 ? 0 : lastBoundary + 2;
  const after = document.slice(offset + excerptLength);
  const ending = /[.!?](?:\s|$)/.exec(after);
  const end = ending
    ? offset + excerptLength + ending.index + 1
    : document.length;
  return document.slice(start, end);
}

function containsNegativeOrQualifiedAssertion(excerpt: string): boolean {
  return (
    /\b(?:no|not|never|without|lack(?:s|ing)?|does not|do not|is not|are not|cannot|can't|doesn't|don't|isn't|aren't|may|might|could|possibly|potentially|perhaps|likely|apparently|reportedly|allegedly|unverified|unconfirmed|suspected|believed to|seems?|appears?|estimated?|approximately|approx\.?|roughly|around|about|circa|near|close to|as many as|up to|at least|at most|more than|less than|fewer than|greater than|or more|or fewer|under|over|previously|formerly|historically|used to|plans? to|intends? to|expects? to|will)\b/.test(
      excerpt,
    ) ||
    /(?:[?<>~≈]|\d\s*\+)/.test(excerpt)
  );
}

function hasExactHeadcountExpression(
  excerpt: string,
  minimum: number,
  maximum: number,
): boolean {
  const normalizedNumbers = excerpt.replaceAll(",", "");
  return headcountExpression(minimum, maximum).test(normalizedNumbers);
}

function assertsTargetOrganization(
  sentence: string,
  organizationName: string,
  observation: Extract<CompanyFitObservationInput, { state: "VERIFIED" }>,
  firstParty: boolean,
): boolean {
  const factOffset = observation.factType === "HEADCOUNT"
    ? headcountExpression(observation.minimum, observation.maximum).exec(
        sentence.replaceAll(",", ""),
      )?.index ?? -1
    : sentence.lastIndexOf(normalizeText(observation.value));
  if (factOffset < 0) return false;

  const beforeFact = sentence.slice(0, factOffset);
  const organizationSubject = normalizeText(organizationName).replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const subject = new RegExp(
    `^(?:${organizationSubject}${firstParty ? "|(?:the|this|our)\\s+(?:company|organization|business)|(?:official\\s+)?company\\s+(?:profile|facts|website|page|report)|we|our\\s+(?:workforce|employees|headcount)" : ""})\\b`,
  ).exec(beforeFact);
  if (!subject) return false;

  const relation = beforeFact.slice(subject[0].length).trim();
  if (
    /\b(?:supplier|vendor|partner|client|customer|competitor|contractor|subcontractor|distributor|franchisee|investee|subsidiary|affiliate|parent|sister company|portfolio company|joint venture)\b/.test(
      relation,
    )
  ) {
    return false;
  }

  if (observation.factType === "HEADCOUNT") {
    return /^(?:has|employs?|reports?|lists?|maintains?|counts?|has exactly|employs? exactly)$/.test(
      relation,
    );
  }
  if (observation.factType === "GEOGRAPHY") {
    return /^(?:operates? (?:in|across)|(?:is )?(?:based|headquartered|located) in|has (?:an? )?offices? in|serves customers in)(?: the)?$/.test(
      relation,
    );
  }
  return (
    /^(?:provides?|offers?|sells?|operates? as|is(?: an?)?)$/.test(relation)
  );
}

function isFirstPartySource(source: EvidenceSource | undefined, domain: string | null): boolean {
  if (!source || source.authority !== "FIRST_PARTY" || !domain) return false;
  try {
    const url = new URL(source.url);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const target = domain.toLowerCase().replace(/^www\./, "");
    return ["http:", "https:"].includes(url.protocol) && (host === target || host.endsWith(`.${target}`));
  } catch {
    return false;
  }
}

function headcountExpression(minimum: number, maximum: number): RegExp {
  const population = "(?:employees?|workers?|people employed|workforce)";
  const count = minimum === maximum
    ? `${minimum}`
    : `${minimum}\\s*(?:-|–|—|to|through)\\s*${maximum}`;
  return new RegExp(`\\b${count}\\s+${population}\\b`);
}

function containsWholeValue(excerpt: string, value: string): boolean {
  const normalizedValue = normalizeText(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${normalizedValue}(?:$|[^\\p{L}\\p{N}])`, "u").test(excerpt);
}

function statesTextFactRelation(
  sentence: string,
  factType: "GEOGRAPHY" | "BUSINESS_MODEL",
  value: string,
): boolean {
  const quotedValue = normalizeText(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const relation = factType === "GEOGRAPHY"
    ? "(?:operates?\\s+(?:in|across)|(?:is\\s+)?(?:based|headquartered|located)\\s+in|has\\s+(?:an?\\s+)?offices?\\s+in|serves\\s+customers\\s+in)"
    : "(?:provides?|offers?|sells?|operates?\\s+as|is(?:\\s+an?)?)";
  return new RegExp(`\\b${relation}\\s+(?:the\\s+)?${quotedValue}(?:$|[^\\p{L}\\p{N}])`, "u").test(sentence);
}

function isTeamOrLeadershipContext(
  excerpt: string,
  source: EvidenceSource | undefined,
): boolean {
  const pageContext = normalizeText(
    `${source?.url ?? ""} ${source?.title ?? ""}`,
  );
  const teamTerms =
    /\b(team|leadership|our people|meet (?:the|our)|staff directory|team members|employee directory|office|branch|department|division|subsidiary)\b/;
  return (
    teamTerms.test(excerpt) ||
    teamTerms.test(pageContext) ||
    /\/(?:team|leadership|people|staff)(?:[/?#._-]|$)/.test(pageContext)
  );
}

function observationFingerprint(
  organizationId: string,
  observation: CompanyFitObservationInput,
): string {
  const value =
    observation.state === "UNKNOWN"
      ? { state: observation.state }
      : observation.factType === "HEADCOUNT"
        ? {
            state: observation.state,
            sourceId: observation.sourceId,
            minimum: observation.minimum,
            maximum: observation.maximum,
          }
        : {
            state: observation.state,
            sourceId: observation.sourceId,
            value: normalizeText(observation.value),
          };
  return createHash("sha256")
    .update(JSON.stringify({ organizationId, factType: observation.factType, value }))
    .digest("hex");
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function toFact(observations: PersistedObservation[]) {
  const evidenced = observations.filter(({ sourceId }) => sourceId !== null);
  const state = evidenced.some(({ state }) => state === "CONFLICT")
    ? "CONFLICT"
    : evidenced.length > 0
      ? "VERIFIED"
      : "UNKNOWN";
  return {
    state,
    observations: observations.map((observation) => ({
      id: observation.id,
      state: observation.state,
      headcount:
        observation.factType === "HEADCOUNT" &&
        observation.headcountMin !== null &&
        observation.headcountMax !== null
          ? {
              minimum: observation.headcountMin,
              maximum: observation.headcountMax,
            }
          : null,
      value: observation.textValue,
      confidence: observation.confidence,
      capturedAt: observation.capturedAt,
      evidenceExcerpt: observation.evidenceExcerpt,
      conflictingSourceIds: observation.conflictingSourceIds,
      extractionRunId: observation.extractionRunId,
      freshness: observation.source
        ? {
            currentness: "UNKNOWN",
            reason: "NO_AGE_POLICY_APPLIED",
            state: observation.source.publishedAt
              ? "PUBLISHED_AT_KNOWN"
              : "CAPTURE_ONLY",
            publishedAt: observation.source.publishedAt,
            capturedAt: observation.source.capturedAt,
          }
        : {
            currentness: "UNKNOWN",
            reason: "NO_SOURCE",
            state: "UNKNOWN",
            publishedAt: null,
            capturedAt: null,
          },
      source: observation.source,
    })),
  };
}
