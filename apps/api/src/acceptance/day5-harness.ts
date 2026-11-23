import { createHash, randomUUID } from "node:crypto";

import type { PrismaClient } from "@tcpl-marketer/database";
import { z } from "zod";

import { diagnosticCandidateInclude, diagnosticSnapshotHash } from "./diagnostic-snapshot.js";

type HarnessFocus = "scoring" | "people";
type HarnessEnvironment = Record<string, string | undefined>;

const workflowResponseSchema = z.object({
  executionId: z.union([z.string(), z.number()]).transform(String),
  scoring: z.object({
    id: z.uuid(),
    leadCandidateId: z.uuid(),
    candidateStatus: z.enum(["QUALIFIED", "BDE_REVIEW", "REJECTED"]),
    cached: z.boolean(),
    result: z.object({
      qualified: z.boolean(),
      grade: z.string(),
      recommendedAction: z.string(),
    }),
  }),
  people: z.unknown().optional(),
});

export async function runDay5Harness(
  database: PrismaClient,
  environment: HarnessEnvironment,
  focus: HarnessFocus,
  request: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const campaignId = z.uuid().parse(environment.F001_CAMPAIGN_ID?.trim());
  const candidateId = z.uuid().parse(environment.F001_CANDIDATE_ID?.trim());
  const execute = environment.F001_EXECUTE === "1";
  const cleanupRequested = environment.F001_CLEANUP === "1";
  const reconcileRequested = environment.F001_RECONCILE === "1";
  if (execute && cleanupRequested) {
    throw new Error("Run and cleanup must be separate operations");
  }
  if (execute && reconcileRequested) {
    throw new Error("Run and reconciliation must be separate operations");
  }
  if (
    environment.F001_EXECUTE &&
    !["0", "1"].includes(environment.F001_EXECUTE)
  ) {
    throw new Error("F001_EXECUTE must be 0 or 1");
  }
  if (environment.F001_RECONCILE && !["0", "1"].includes(environment.F001_RECONCILE)) {
    throw new Error("F001_RECONCILE must be 0 or 1");
  }
  if (
    environment.F001_CLEANUP &&
    !["0", "1"].includes(environment.F001_CLEANUP)
  ) {
    throw new Error("F001_CLEANUP must be 0 or 1");
  }

  const candidate = await database.leadCandidate.findUnique({
    where: { id: candidateId },
    include: diagnosticCandidateInclude,
  });
  if (!candidate || candidate.campaignId !== campaignId) {
    throw new Error("Candidate does not belong to the selected campaign");
  }

  const campaign = candidate.campaign;
  const existingDiagnostic = await database.acceptanceDiagnosticRun.findFirst({
    where: { leadCandidateId: candidateId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      status: true,
      externalRunId: true,
      scoreId: true,
      candidateUpdatedAt: true,
      createdAt: true,
    },
  });
  const weights = {
    sectorFit: campaign.sectorFitWeight,
    capabilityMatch: campaign.capabilityMatchWeight,
    targetClientFit: campaign.targetClientFitWeight,
    outsourcingProbability: campaign.outsourcingWeight,
    buyingIntent: campaign.buyingIntentWeight,
    businessMomentum: campaign.businessMomentumWeight,
    decisionMakerQuality: campaign.decisionMakerWeight,
    contactConfidence: campaign.contactConfidenceWeight,
  };
  const capabilityOnly =
    weights.capabilityMatch === 100 &&
    Object.entries(weights).every(
      ([name, value]) => name === "capabilityMatch" || value === 0,
    );
  const manuallyReviewedPeople = candidate.organization.people
    .filter((person) => person.provenance !== "APPLICATION")
    .map(({ id, provenance, sourceProvider }) => ({ id, provenance, sourceProvider }));
  const reasons = [
    ...(campaign.status !== "RUNNING" ? ["Campaign is not RUNNING"] : []),
    ...(!["DISCOVERED", "VALIDATING"].includes(candidate.status)
      ? [`Candidate is ${candidate.status}; a fresh diagnostic dispatch is unsafe until its existing stage is reconciled`]
      : []),
    ...(campaign.automationMode !== "MANUAL_REVIEW"
      ? ["Campaign is not in MANUAL_REVIEW"]
      : []),
    ...(campaign.capabilities.length === 0
      ? ["Campaign has no capabilities"]
      : []),
    ...(campaign.targets.length === 0
      ? ["Campaign has no target-client profile"]
      : []),
    ...(Object.values(weights).reduce((sum, value) => sum + value, 0) !== 100
      ? ["Configured scoring weights do not total 100"]
      : []),
    ...(capabilityOnly ? ["Capability-only scoring fixture"] : []),
    ...(candidate.provenance !== "APPLICATION"
      ? [`Candidate provenance is ${candidate.provenance}`]
      : []),
    ...(campaign.provenance !== "APPLICATION"
      ? [`Campaign provenance is ${campaign.provenance}`]
      : []),
    ...(manuallyReviewedPeople.length > 0
      ? ["Organization contains unknown, manually reviewed or fixture people"]
      : []),
    ...(candidate.organization.sources.length === 0
      ? ["No stored source documents for research; wait for the protected crawl stage"]
      : []),
    ...(existingDiagnostic
      ? [`Diagnostic run ${existingDiagnostic.id} is ${existingDiagnostic.status}; inspect and reconcile before another dispatch`]
      : []),
  ];
  const configHash = createHash("sha256")
    .update(
      JSON.stringify({
        campaignId,
        campaignProvenance: campaign.provenance,
        status: campaign.status,
        automationMode: campaign.automationMode,
        minimumScore: campaign.minimumScore,
        weights,
        capabilityIds: campaign.capabilities.map(({ capabilityId }) => capabilityId).sort(),
        targetIds: campaign.targets.map(({ targetClientProfileId }) => targetClientProfileId).sort(),
      }),
    )
    .digest("hex");
  const runId = randomUUID();
  const before = await inspectPersistence(database, candidateId);
  const initialSnapshot = diagnosticSnapshotHash(candidate);

  if (cleanupRequested) {
    return {
      taskId: "F001",
      focus,
      runId,
      mode: "CLEANUP",
      cleanup: {
        requested: true,
        deletedRecords: 0,
        runOwnedRecordIds: [],
        reason: "No canonical test records are owned by this runner; durable diagnostic audit records are retained",
      },
      diagnosticRun: existingDiagnostic,
      campaignId,
      candidateId,
      before,
    };
  }

  if (reconcileRequested) {
    if (!existingDiagnostic) throw new Error("No F001 diagnostic run exists to reconcile");
    if (existingDiagnostic.status === "VERIFIED") {
      return {
        taskId: "F001", focus, runId, mode: "RECONCILE",
        businessAcceptance: "UNVERIFIED", acceptanceEligible: false,
        reasons: ["Diagnostic result was already verified; repeat dispatch remains blocked"],
        diagnosticRun: existingDiagnostic,
        before, after: before,
        cleanup: { requested: false, deletedRecords: 0, runOwnedRecordIds: [] },
      };
    }
    if (existingDiagnostic.status === "CLAIMED") {
      throw new Error("F001 diagnostic is still claimed; inspect the n8n execution before reconciling");
    }
    const current = await database.leadCandidate.findUnique({
      where: { id: candidateId },
      select: { status: true, provenance: true, updatedAt: true },
    });
    const persisted = await inspectPersistence(database, candidateId);
    const verified =
      existingDiagnostic.status === "NEEDS_REVIEW" &&
      persisted.score !== null &&
      persisted.score.createdAt.getTime() >= existingDiagnostic.createdAt.getTime() &&
      (existingDiagnostic.scoreId === null || existingDiagnostic.scoreId === persisted.score.id) &&
      current?.provenance === "APPLICATION" &&
      current !== null &&
      current.updatedAt.getTime() === existingDiagnostic.candidateUpdatedAt.getTime() &&
      ["QUALIFIED", "BDE_REVIEW", "REJECTED"].includes(current.status);
    await database.acceptanceDiagnosticRun.update({
      where: { id: existingDiagnostic.id },
      data: {
        status: verified ? "VERIFIED" : "NEEDS_REVIEW",
        scoreId: verified ? persisted.score?.id : undefined,
        outcome: verified
          ? existingDiagnostic.externalRunId
            ? "RECONCILED_PERSISTED_RESULT"
            : "RECONCILED_PERSISTED_RESULT_NO_WEBHOOK_ACK"
          : "RECONCILIATION_REQUIRED",
        completedAt: verified ? new Date() : undefined,
      },
    });
    return {
      taskId: "F001",
      focus,
      runId,
      mode: "RECONCILE",
      businessAcceptance: "UNVERIFIED",
      acceptanceEligible: false,
      reasons: verified
        ? existingDiagnostic.externalRunId ? [] : ["NestJS result persisted; n8n execution ID was not acknowledged"]
        : ["Persisted state does not prove a completed diagnostic result; manual n8n and PostgreSQL review is required"],
      diagnosticRun: { id: existingDiagnostic.id, status: verified ? "VERIFIED" : "NEEDS_REVIEW" },
      before,
      after: persisted,
      cleanup: { requested: false, deletedRecords: 0, runOwnedRecordIds: [] },
    };
  }

  if (execute && reasons.length > 0) {
    throw new Error(`Candidate is not eligible for an unseeded diagnostic run: ${reasons.join("; ")}`);
  }

  let claimedRunId: string | null = null;
  try {
    let workflow: z.infer<typeof workflowResponseSchema> | null = null;
    if (execute) {
      const secret = environment.N8N_SERVICE_SECRET?.trim();
      if (!secret) throw new Error("N8N_SERVICE_SECRET is required to execute");
      const endpoint = z.url().parse(
        environment.N8N_COMPANY_RESEARCH_WEBHOOK_URL?.trim() ||
          "http://localhost:5678/webhook/company-research",
      );
      if (!["http:", "https:"].includes(new URL(endpoint).protocol)) {
        throw new Error("The company research webhook must use HTTP or HTTPS");
      }
      await database.$transaction(async (transaction) => {
        const latest = await transaction.leadCandidate.findUnique({
          where: { id: candidateId },
          include: diagnosticCandidateInclude,
        });
        if (!latest || diagnosticSnapshotHash(latest) !== initialSnapshot) {
          throw new Error(`F001 ${runId}: campaign, candidate or people changed before execution; inspect again`);
        }
        await transaction.acceptanceDiagnosticRun.create({
          data: {
            id: runId,
            leadCandidateId: candidateId,
            campaignId,
            focus,
            inputHash: initialSnapshot,
            candidateUpdatedAt: candidate.updatedAt,
          },
        });
      });
      claimedRunId = runId;
      const beforeDispatch = await database.leadCandidate.findUnique({
        where: { id: candidateId },
        include: diagnosticCandidateInclude,
      });
      if (!beforeDispatch || diagnosticSnapshotHash(beforeDispatch) !== initialSnapshot) {
        throw new Error(`F001 ${runId}: input changed after the durable claim; no workflow request was sent`);
      }
      let response: Response;
      try {
        response = await request(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            candidateId,
            diagnosticRunId: runId,
            inputHash: initialSnapshot,
          }),
          signal: AbortSignal.timeout(180_000),
        });
      } catch {
        throw new Error(`F001 ${runId}: workflow outcome unknown; inspect persisted state before retrying`);
      }
      if (!response.ok) {
        throw new Error(`F001 ${runId}: workflow returned HTTP ${response.status}; inspect persisted state before retrying`);
      }
      let responseBody: unknown;
      try {
        responseBody = await response.json();
      } catch {
        throw new Error(`F001 ${runId}: workflow response was not JSON; inspect persisted state before retrying`);
      }
      const parsed = workflowResponseSchema.safeParse(responseBody);
      if (!parsed.success) {
        throw new Error(`F001 ${runId}: workflow response was invalid; inspect persisted state before retrying`);
      }
      workflow = parsed.data;
      if (workflow.scoring.leadCandidateId !== candidateId) {
        throw new Error("Workflow returned a score for another candidate");
      }
    }

    const after = execute ? await inspectPersistence(database, candidateId) : before;
    if (workflow && after.score?.id !== workflow.scoring.id) {
      throw new Error(`F001 ${runId}: workflow score was not the latest persisted score; inspect persisted state`);
    }
    const currentCampaign = execute
      ? await database.campaign.findUnique({
          where: { id: campaignId },
          select: { updatedAt: true, provenance: true },
        })
      : null;
    const currentCandidate = execute
      ? await database.leadCandidate.findUnique({
          where: { id: candidateId },
          select: { campaignId: true, status: true, provenance: true },
        })
      : null;
    const currentSources = execute
      ? await database.source.findMany({
          where: { organizationId: candidate.organizationId, webDocument: { isNot: null } },
          orderBy: [{ capturedAt: "desc" }, { id: "desc" }],
          take: 25,
          select: {
            id: true, url: true, title: true, contentHash: true, capturedAt: true,
            webDocument: { select: { text: true } },
          },
        })
      : null;
    if (
      execute &&
      (currentCampaign?.updatedAt.getTime() !== campaign.updatedAt.getTime() ||
        currentCampaign?.provenance !== campaign.provenance)
    ) {
      throw new Error(`F001 ${runId}: campaign changed during the diagnostic run; inspect persisted state`);
    }
    if (
      workflow &&
      (currentCandidate?.campaignId !== campaignId ||
        currentCandidate?.provenance !== "APPLICATION" ||
        currentCandidate?.status !== workflow.scoring.candidateStatus)
    ) {
      throw new Error(`F001 ${runId}: persisted candidate does not match the workflow result; inspect persisted state`);
    }
    if (workflow && JSON.stringify(currentSources) !== JSON.stringify(candidate.organization.sources)) {
      throw new Error(`F001 ${runId}: stored research sources changed during execution; inspect persisted state`);
    }
    const observedPeople = execute
      ? await database.person.findMany({
          where: { organizationId: candidate.organizationId },
          select: {
            id: true,
            provenance: true,
            sourceProvider: true,
            sourceType: true,
            sourceUrl: true,
            roles: {
              where: { isCurrent: true },
              select: { id: true, sourceUrl: true },
            },
          },
        })
      : candidate.organization.people;
    const peopleStage =
      workflow === null
        ? "NOT_RUN"
        : workflow.people == null
          ? "NOT_RETURNED"
          : "RETURNED";
    const postRunIssues = execute && observedPeople.some((person) => person.provenance !== "APPLICATION")
      ? ["Organization contains unknown, manually reviewed or fixture people after execution"]
      : [];
    const finalReasons = [
      ...reasons,
      ...postRunIssues,
      ...(claimedRunId ? ["Diagnostic run is recorded; repeat dispatch is blocked"] : []),
    ];
    if (claimedRunId) {
      await database.acceptanceDiagnosticRun.update({
        where: { id: claimedRunId },
        data: {
          status: postRunIssues.length === 0 ? "VERIFIED" : "NEEDS_REVIEW",
          externalRunId: workflow?.executionId,
          scoreId: workflow?.scoring.id,
          outcome: postRunIssues.length === 0 ? "PERSISTED_RESULT_MATCHED" : "PROVENANCE_CHANGED",
          completedAt: new Date(),
        },
      });
    }
    return {
      taskId: "F001",
      focus,
      runId,
      diagnosticRunId: claimedRunId,
      mode: execute ? "DIAGNOSTIC_RUN" : "INSPECT",
      businessAcceptance: "UNVERIFIED",
      acceptanceEligible: finalReasons.length === 0,
      reasons: finalReasons,
      diagnosticRun: claimedRunId
        ? { id: claimedRunId, status: postRunIssues.length === 0 ? "VERIFIED" : "NEEDS_REVIEW" }
        : existingDiagnostic,
      campaign: {
        id: campaignId,
        status: campaign.status,
        automationMode: campaign.automationMode,
        configHash,
        snapshotHash: initialSnapshot,
        weights,
        capabilityOnly,
        provenance: campaign.provenance,
        fixtureProvenance: campaign.provenance === "ACCEPTANCE_FIXTURE",
      },
      candidate: {
        id: candidateId,
        status: candidate.status,
        persistedStatus: currentCandidate?.status ?? candidate.status,
        organizationId: candidate.organizationId,
        searchStrategyType: candidate.searchStrategyType,
        provenance: candidate.provenance,
        fixtureProvenance: candidate.provenance === "ACCEPTANCE_FIXTURE",
      },
      peopleProvenance: {
        manuallyReviewedOrFixture: observedPeople
          .filter((person) => person.provenance !== "APPLICATION")
          .map(({ id, provenance, sourceProvider }) => ({ id, provenance, sourceProvider })),
        observed: observedPeople.map((person) => ({
          id: person.id,
          provenance: person.provenance,
          sourceProvider: person.sourceProvider,
          sourceType: person.sourceType,
          sourceUrl: person.sourceUrl,
          currentRoleSourceUrls: person.roles.map((role) => role.sourceUrl),
        })),
      },
      workflow: workflow
        ? {
            executionId: workflow.executionId,
            scoringId: workflow.scoring.id,
            candidateStatus: workflow.scoring.candidateStatus,
            scoreCached: workflow.scoring.cached,
            peopleStage,
          }
        : { peopleStage },
      before,
      after,
      cleanup: {
        requested: false,
        deletedRecords: 0,
        runOwnedRecordIds: [],
      },
    };
  } catch (error) {
    if (claimedRunId) {
      await database.acceptanceDiagnosticRun.updateMany({
        where: { id: claimedRunId, status: "CLAIMED" },
        data: {
          status: "NEEDS_REVIEW",
          outcome: "RECONCILE_REQUIRED",
          completedAt: new Date(),
        },
      });
    }
    throw error;
  }
}

async function inspectPersistence(database: PrismaClient, candidateId: string) {
  const [score, selection] = await Promise.all([
    database.leadScore.findFirst({
      where: { leadCandidateId: candidateId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        score: true,
        grade: true,
        qualified: true,
        recommendedAction: true,
        weights: true,
        evidenceIds: true,
        createdAt: true,
      },
    }),
    database.decisionMakerSelection.findFirst({
      where: { leadCandidateId: candidateId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        id: true,
        status: true,
        warnings: true,
        createdAt: true,
        assignments: {
          select: {
            slot: true,
            personId: true,
            personRoleId: true,
            person: { select: { sourceProvider: true, sourceUrl: true } },
            personRole: { select: { sourceUrl: true } },
          },
        },
      },
    }),
  ]);
  return { score, selection };
}
