import { createHash } from "node:crypto";

import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  ClaimExtractionSchema,
  type ClaimExtraction,
  type ExtractedCompanyFitObservation,
  type ExtractedClaim,
} from "@tcpl-marketer/ai-contracts";
import { Prisma } from "@tcpl-marketer/database";
import {
  CLAIM_EXTRACTOR,
  type ClaimExtractionRequest,
  type ClaimExtractor,
  type ProviderRun,
} from "@tcpl-marketer/provider-contracts";

import { ProviderCallAuditor } from "../audit/provider-call-auditor.service.js";
import { bindCampaign } from "../common/correlation/correlation-context.js";
import { DatabaseService } from "../database/database.service.js";
import { assertDiagnosticClaim } from "../acceptance/diagnostic-claim.js";
import {
  COMPANY_FIT_FACT_TYPES,
  CompanyFitEvidenceService,
} from "./company-fit-evidence.service.js";

const MAX_DOCUMENTS = 25;
const MAX_DOCUMENT_CHARACTERS = 20_000;
const MAX_TOTAL_CHARACTERS = 120_000;
const STALE_RUN_AFTER_MS = 15 * 60 * 1_000;

const profileInclude = {
  organization: { select: { id: true, name: true } },
  claims: {
    orderBy: [{ claimType: "asc" }, { statement: "asc" }],
    include: {
      evidence: {
        include: {
          source: {
            select: {
              id: true,
              url: true,
              title: true,
              publisher: true,
              authority: true,
              capturedAt: true,
              contentHash: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.ClaimExtractionRunInclude;

type PersistedProfileRun = Prisma.ClaimExtractionRunGetPayload<{
  include: typeof profileInclude;
}>;

export interface CompanyIntelligenceProfile {
  organization: { id: string; name: string };
  extraction: {
    id: string;
    provider: string;
    model: string;
    prompt: { name: string; version: string };
    providerResponseId: string | null;
    completedAt: Date;
    cached: boolean;
  };
  claims: Array<{
    id: string;
    type: string;
    statement: string;
    sources: Array<{
      id: string;
      url: string;
      title: string | null;
      publisher: string | null;
      authority: string;
      capturedAt: Date;
      contentHash: string;
    }>;
  }>;
  companyFit: unknown;
}

export interface LeadCandidateResearchResult {
  candidate: { id: string; organizationId: string; status: string };
  profile: CompanyIntelligenceProfile;
}

@Injectable()
export class ClaimExtractionService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CLAIM_EXTRACTOR) private readonly extractor: ClaimExtractor,
    @Inject(CompanyFitEvidenceService)
    private readonly companyFit: CompanyFitEvidenceService,
    @Inject(ProviderCallAuditor) private readonly providerCalls: ProviderCallAuditor,
  ) {}

  async extractForOrganization(
    organizationId: string,
  ): Promise<ProviderRun<ClaimExtraction>> {
    const context = await this.loadContext(organizationId);
    return this.extractAndValidate(context.request);
  }

  async researchOrganization(
    organizationId: string,
  ): Promise<CompanyIntelligenceProfile> {
    const context = await this.loadContext(organizationId);
    const configuration = this.extractor.getConfiguration();
    const documentSetHash = sha256(
      JSON.stringify(
        context.sourceHashes
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([url, contentHash]) => ({ url, contentHash })),
      ),
    );
    const idempotencyKey = sha256(
      JSON.stringify({
        organizationId,
        documentSetHash,
        provider: configuration.provider,
        model: configuration.model,
        prompt: configuration.prompt,
      }),
    );

    const acquired = await this.acquireRun({
      organizationId,
      idempotencyKey,
      documentSetHash,
      ...configuration,
    });
    if (acquired.cached) {
      return this.withCompanyFit(toProfile(acquired.run, true), organizationId);
    }

    try {
      // One key per lease of this extraction run: duplicate delivery of the same lease never reserves
      // twice, while a re-acquired run after a failure is a new, counted call.
      const providerRun = await this.extractAndValidate(
        context.request,
        `claim-extraction:${acquired.run.id}:${acquired.run.startedAt.getTime()}`,
      );
      if (
        providerRun.prompt.name !== configuration.prompt.name ||
        providerRun.prompt.version !== configuration.prompt.version
      ) {
        throw new BadGatewayException(
          "Claim provider returned unexpected prompt metadata",
        );
      }
      const claims = canonicalClaims(providerRun.data.claims);
      await this.database.client.$transaction(async (transaction) => {
        const finalized = await transaction.claimExtractionRun.updateMany({
          where: {
            id: acquired.run.id,
            status: "RUNNING",
            startedAt: acquired.run.startedAt,
          },
          data: {
            status: "SUCCEEDED",
            model: providerRun.model,
            promptName: providerRun.prompt.name,
            promptVersion: providerRun.prompt.version,
            providerResponseId: providerRun.providerResponseId,
            inputTokens: providerRun.usage?.inputTokens,
            outputTokens: providerRun.usage?.outputTokens,
            totalTokens: providerRun.usage?.totalTokens,
            error: null,
            completedAt: new Date(),
          },
        });
        if (finalized.count !== 1) {
          throw new ConflictException(
            "Company research lease changed before extraction completed",
          );
        }
        await transaction.claim.deleteMany({
          where: { extractionRunId: acquired.run.id },
        });
        for (const claim of claims) {
          await transaction.claim.create({
            data: {
              organizationId,
              extractionRunId: acquired.run.id,
              claimType: claim.type,
              statement: claim.statement,
              fingerprint: claim.fingerprint,
              evidence: {
                create: claim.evidenceIds.map((sourceId) => ({ sourceId })),
              },
            },
          });
        }
        await this.companyFit.recordInTransaction(
          transaction,
          organizationId,
          completeCompanyFitObservations(
            providerRun.data.companyFitObservations,
          ),
          acquired.run.id,
        );
      });
      return this.withCompanyFit(
        toProfile(await this.findProfileRun(acquired.run.id), false),
        organizationId,
      );
    } catch (error) {
      await this.database.client.claimExtractionRun
        .updateMany({
          where: {
            id: acquired.run.id,
            status: "RUNNING",
            startedAt: acquired.run.startedAt,
          },
          data: {
            status: "FAILED",
            error: errorMessage(error),
            completedAt: new Date(),
          },
        })
        .catch(() => undefined);
      throw error;
    }
  }

  async researchLeadCandidate(
    candidateId: string,
    diagnosticRunId?: string,
    inputHash?: string,
  ): Promise<LeadCandidateResearchResult> {
    const candidate = await this.database.client.leadCandidate.findUnique({
      where: { id: candidateId },
      select: { id: true, organizationId: true, campaignId: true, status: true, updatedAt: true },
    });
    if (!candidate) throw new NotFoundException("Lead candidate not found");
    // Provider spend for this candidate counts toward its campaign and run caps.
    bindCampaign(candidate.campaignId);
    const claim = await assertDiagnosticClaim(
      this.database.client,
      candidateId,
      diagnosticRunId,
      inputHash,
      true,
    );
    if (claim && claim.candidateUpdatedAt.getTime() !== candidate.updatedAt.getTime()) {
      throw new ConflictException(
        "Lead candidate changed after the F001 diagnostic claim; reconcile before continuing",
      );
    }
    if (
      [
        "ANALYSING",
        "SCORING",
        "QUALIFIED",
        "BDE_REVIEW",
        "REJECTED",
      ].includes(candidate.status)
    ) {
      if (diagnosticRunId && inputHash) {
        await this.database.client.acceptanceDiagnosticRun.updateMany({
          where: {
            id: diagnosticRunId,
            leadCandidateId: candidateId,
            status: "CLAIMED",
            inputHash,
          },
          data: { candidateUpdatedAt: candidate.updatedAt },
        });
      }
      return {
        candidate,
        profile: await this.researchOrganization(candidate.organizationId),
      };
    }

    const started = await this.database.client.leadCandidate.updateMany({
      where: {
        id: candidate.id,
        status: { in: ["DISCOVERED", "VALIDATING"] },
        updatedAt: candidate.updatedAt,
      },
      data: { status: "RESEARCHING" },
    });
    if (started.count !== 1) {
      throw new ConflictException(
        "Lead candidate changed before diagnostic research started",
      );
    }
    const researching = await this.database.client.leadCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
      select: { organizationId: true, status: true, updatedAt: true },
    });
    let profile: CompanyIntelligenceProfile;
    try {
      profile = await this.researchOrganization(candidate.organizationId);
    } catch (error) {
      await this.database.client.$transaction(async (transaction) => {
        await transaction.leadCandidate.updateMany({
          where: {
            id: candidate.id,
            status: "RESEARCHING",
            updatedAt: researching.updatedAt,
          },
          data: { status: "VALIDATING" },
        });
        // F001 claims intentionally forbid blind replay. Make the failure
        // explicit rather than leave a CLAIMED run with a stale snapshot.
        if (diagnosticRunId && inputHash) {
          await transaction.acceptanceDiagnosticRun.updateMany({
            where: { id: diagnosticRunId, leadCandidateId: candidate.id, status: "CLAIMED", inputHash },
            data: { status: "NEEDS_REVIEW", outcome: "RECONCILE_REQUIRED" },
          });
        }
      });
      throw error;
    }
    const analysed = await this.database.client.leadCandidate.updateMany({
      where: {
        id: candidate.id,
        status: "RESEARCHING",
        updatedAt: researching.updatedAt,
      },
      data: { status: "ANALYSING" },
    });
    if (analysed.count !== 1) {
      throw new ConflictException(
        "Lead candidate changed during diagnostic research; reconcile before continuing",
      );
    }
    const current = await this.database.client.leadCandidate.findUniqueOrThrow({
      where: { id: candidate.id },
      select: { status: true, updatedAt: true },
    });
    if (diagnosticRunId && inputHash) {
      const updatedClaim = await this.database.client.acceptanceDiagnosticRun.updateMany({
        where: {
          id: diagnosticRunId,
          leadCandidateId: candidateId,
          status: "CLAIMED",
          inputHash,
        },
        data: { candidateUpdatedAt: current.updatedAt },
      });
      if (updatedClaim.count !== 1) {
        throw new ConflictException(
          "F001 diagnostic claim changed during research; reconcile before continuing",
        );
      }
    }
    return {
      candidate: {
        id: candidate.id,
        organizationId: candidate.organizationId,
        status: current.status,
      },
      profile,
    };
  }

  async getCompanyProfile(
    organizationId: string,
  ): Promise<CompanyIntelligenceProfile> {
    const run = await this.database.client.claimExtractionRun.findFirst({
      where: { organizationId, status: "SUCCEEDED" },
      orderBy: { completedAt: "desc" },
      include: profileInclude,
    });
    if (run) {
      return this.withCompanyFit(toProfile(run, true), organizationId);
    }

    const organization = await this.database.client.organization.findUnique({
      where: { id: organizationId },
      select: { id: true },
    });
    if (!organization) throw new NotFoundException("Organization not found");
    throw new NotFoundException("No completed company research profile found");
  }

  private async withCompanyFit(
    profile: Omit<CompanyIntelligenceProfile, "companyFit">,
    organizationId: string,
  ): Promise<CompanyIntelligenceProfile> {
    return {
      ...profile,
      companyFit: await this.companyFit.getProfile(organizationId),
    };
  }

  private async loadContext(organizationId: string): Promise<{
    request: ClaimExtractionRequest;
    sourceHashes: Array<[string, string]>;
  }> {
    const organization = await this.database.client.organization.findUnique({
      where: { id: organizationId },
      select: {
        id: true,
        name: true,
        sources: {
          where: { webDocument: { isNot: null } },
          orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
          take: MAX_DOCUMENTS,
          select: {
            id: true,
            url: true,
            title: true,
            contentHash: true,
            webDocument: { select: { text: true } },
          },
        },
      },
    });
    if (!organization) throw new NotFoundException("Organization not found");

    const bounded = boundedDocuments(organization.sources);
    if (bounded.documents.length === 0) {
      await this.companyFit.recordUnknowns(organizationId);
      throw new UnprocessableEntityException(
        "No stored documents are available for claim extraction",
      );
    }
    return {
      request: {
        organizationId: organization.id,
        organizationName: organization.name,
        documents: bounded.documents,
      },
      sourceHashes: bounded.sourceHashes,
    };
  }

  private async extractAndValidate(
    request: ClaimExtractionRequest,
    callKey?: string,
  ): Promise<ProviderRun<ClaimExtraction>> {
    const run = await this.providerCalls.run(
      { provider: "openai", operation: "claim-extraction", callKey },
      (call) => this.extractor.extract(request, call),
    );
    return validateProviderRun(
      run,
      new Set(request.documents.map(({ evidenceId }) => evidenceId)),
    );
  }

  private async acquireRun(input: {
    organizationId: string;
    idempotencyKey: string;
    documentSetHash: string;
    provider: string;
    model: string;
    prompt: { name: string; version: string };
  }): Promise<{ run: PersistedProfileRun; cached: boolean }> {
    const existing = await this.database.client.claimExtractionRun.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
      include: profileInclude,
    });
    if (existing?.status === "SUCCEEDED") {
      return { run: existing, cached: true };
    }
    if (existing) return this.reacquireRun(existing);

    try {
      const created = await this.database.client.claimExtractionRun.create({
        data: {
          organizationId: input.organizationId,
          idempotencyKey: input.idempotencyKey,
          documentSetHash: input.documentSetHash,
          provider: input.provider,
          model: input.model,
          promptName: input.prompt.name,
          promptVersion: input.prompt.version,
        },
        include: profileInclude,
      });
      return { run: created, cached: false };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const raced = await this.database.client.claimExtractionRun.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
        include: profileInclude,
      });
      if (raced?.status === "SUCCEEDED") return { run: raced, cached: true };
      throw new ConflictException("Company research is already running");
    }
  }

  private async reacquireRun(
    run: PersistedProfileRun,
  ): Promise<{ run: PersistedProfileRun; cached: false }> {
    const staleBefore = new Date(Date.now() - STALE_RUN_AFTER_MS);
    const recovered = await this.database.client.claimExtractionRun.updateMany({
      where: {
        id: run.id,
        OR: [
          { status: "FAILED" },
          { status: "RUNNING", startedAt: { lt: staleBefore } },
        ],
      },
      data: {
        status: "RUNNING",
        providerResponseId: null,
        inputTokens: null,
        outputTokens: null,
        totalTokens: null,
        error: null,
        startedAt: new Date(),
        completedAt: null,
      },
    });
    if (recovered.count !== 1) {
      throw new ConflictException("Company research is already running");
    }
    return { run: await this.findProfileRun(run.id), cached: false };
  }

  private async findProfileRun(id: string): Promise<PersistedProfileRun> {
    return this.database.client.claimExtractionRun.findUniqueOrThrow({
      where: { id },
      include: profileInclude,
    });
  }
}

function boundedDocuments(
  sources: Array<{
    id: string;
    url: string;
    title: string | null;
    contentHash: string;
    webDocument: { text: string } | null;
  }>,
): {
  documents: ClaimExtractionRequest["documents"];
  sourceHashes: Array<[string, string]>;
} {
  const documents: ClaimExtractionRequest["documents"] = [];
  const sourceHashes: Array<[string, string]> = [];
  const seen = new Set<string>();
  let remaining = MAX_TOTAL_CHARACTERS;
  for (const source of sources) {
    if (!source.webDocument || remaining <= 0) continue;
    // The same page with the same content from a repeated crawl is one document, newest first. The document
    // set is keyed on page and content, not on source rows, so an unchanged re-crawl reuses the earlier research.
    const identity = `${source.url}\n${source.contentHash}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const text = source.webDocument.text.slice(
      0,
      Math.min(MAX_DOCUMENT_CHARACTERS, remaining),
    );
    if (!text.trim()) continue;
    documents.push({
      evidenceId: source.id,
      url: source.url,
      title: source.title,
      text,
    });
    sourceHashes.push([source.url, source.contentHash]);
    remaining -= text.length;
  }
  return { documents, sourceHashes };
}

function validateProviderRun(
  run: ProviderRun<ClaimExtraction>,
  suppliedEvidenceIds: Set<string>,
): ProviderRun<ClaimExtraction> {
  const parsed = ClaimExtractionSchema.safeParse(run.data);
  if (!parsed.success) {
    throw new BadGatewayException(
      "Claim provider returned invalid structured output",
    );
  }
  for (const claim of parsed.data.claims) {
    if (claim.evidenceIds.some((id) => !suppliedEvidenceIds.has(id))) {
      throw new BadGatewayException(
        "Claim provider returned an unknown evidence ID",
      );
    }
  }
  for (const observation of parsed.data.companyFitObservations) {
    if (
      !suppliedEvidenceIds.has(observation.sourceId) ||
      observation.conflictsWithSourceIds.some(
        (id) => !suppliedEvidenceIds.has(id),
      )
    ) {
      throw new BadGatewayException(
        "Claim provider returned an unknown company-fit evidence ID",
      );
    }
  }
  return { ...run, data: parsed.data };
}

function completeCompanyFitObservations(
  observations: ExtractedCompanyFitObservation[],
) {
  const observedTypes = new Set(observations.map(({ factType }) => factType));
  return {
    observations: [
      ...observations.map((observation) => ({
        ...observation,
        state: "VERIFIED" as const,
      })),
      ...COMPANY_FIT_FACT_TYPES.filter(
        (factType) => !observedTypes.has(factType),
      ).map((factType) => ({ factType, state: "UNKNOWN" as const })),
    ],
  };
}

function canonicalClaims(
  claims: ExtractedClaim[],
): Array<ExtractedClaim & { fingerprint: string }> {
  const unique = new Map<string, ExtractedClaim & { fingerprint: string }>();
  for (const claim of claims) {
    const normalized = claim.statement.trim().replace(/\s+/g, " ").toLowerCase();
    const fingerprint = sha256(`${claim.type}\n${normalized}`);
    const existing = unique.get(fingerprint);
    if (existing) {
      existing.evidenceIds = [
        ...new Set([...existing.evidenceIds, ...claim.evidenceIds]),
      ];
    } else {
      unique.set(fingerprint, {
        ...claim,
        evidenceIds: [...new Set(claim.evidenceIds)],
        fingerprint,
      });
    }
  }
  return [...unique.values()];
}

function toProfile(
  run: PersistedProfileRun,
  cached: boolean,
): Omit<CompanyIntelligenceProfile, "companyFit"> {
  if (!run.completedAt || run.status !== "SUCCEEDED") {
    throw new ConflictException("Company research has not completed");
  }
  return {
    organization: run.organization,
    extraction: {
      id: run.id,
      provider: run.provider,
      model: run.model,
      prompt: { name: run.promptName, version: run.promptVersion },
      providerResponseId: run.providerResponseId,
      completedAt: run.completedAt,
      cached,
    },
    claims: run.claims.map((claim) => ({
      id: claim.id,
      type: claim.claimType,
      statement: claim.statement,
      sources: claim.evidence.map(({ source }) => source),
    })),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown extraction failure").slice(
    0,
    500,
  );
}
