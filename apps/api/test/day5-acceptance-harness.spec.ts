import type { PrismaClient } from "@tcpl-marketer/database";
import { describe, expect, it, vi } from "vitest";

import { runDay5Harness } from "../src/acceptance/day5-harness.js";

const campaignId = "11111111-1111-4111-8111-111111111111";
const candidateId = "22222222-2222-4222-8222-222222222222";
const organizationId = "33333333-3333-4333-8333-333333333333";
const scoreId = "44444444-4444-4444-8444-444444444444";

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: candidateId,
    campaignId,
    organizationId,
    provenance: "APPLICATION",
    status: "DISCOVERED",
    updatedAt: new Date("2026-10-07T00:00:00Z"),
    searchStrategyType: "CAPABILITY",
    campaign: {
      name: "Normal campaign",
      provenance: "APPLICATION",
      status: "RUNNING",
      automationMode: "MANUAL_REVIEW",
      updatedAt: new Date("2026-10-07T00:00:00Z"),
      minimumScore: 70,
      sectorFitWeight: 15,
      capabilityMatchWeight: 20,
      targetClientFitWeight: 15,
      outsourcingWeight: 15,
      buyingIntentWeight: 20,
      businessMomentumWeight: 5,
      decisionMakerWeight: 5,
      contactConfidenceWeight: 5,
      capabilities: [{ capabilityId: "55555555-5555-4555-8555-555555555555" }],
      targets: [{ targetClientProfileId: "66666666-6666-4666-8666-666666666666" }],
    },
    organization: {
      id: organizationId,
      normalizedDomain: "example.test",
      sources: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
      people: [],
    },
    ...overrides,
  };
}

function database(
  selected = candidate(),
  scores: unknown[] = [null],
  selections: unknown[] = [null],
) {
  const findCandidate = vi.fn().mockResolvedValue(selected);
  const findScore = vi.fn();
  const findSelection = vi.fn();
  const findDiagnostic = vi.fn().mockResolvedValue(null);
  const createDiagnostic = vi.fn().mockImplementation(async ({ data }) => ({ id: data.id }));
  const updateDiagnostic = vi.fn().mockResolvedValue({});
  const updateDiagnosticMany = vi.fn().mockResolvedValue({ count: 1 });
  for (const score of scores) findScore.mockResolvedValueOnce(score);
  for (const selection of selections) findSelection.mockResolvedValueOnce(selection);
  const client = {
      leadCandidate: { findUnique: findCandidate },
      leadScore: { findFirst: findScore },
      decisionMakerSelection: { findFirst: findSelection },
      acceptanceDiagnosticRun: {
        findUnique: findDiagnostic,
        findFirst: findDiagnostic,
        create: createDiagnostic,
        update: updateDiagnostic,
        updateMany: updateDiagnosticMany,
      },
      campaign: {
        findUnique: vi.fn().mockResolvedValue({
          updatedAt: selected.campaign.updatedAt,
          provenance: selected.campaign.provenance,
        }),
      },
      person: {
        findMany: vi.fn().mockResolvedValue(selected.organization.people),
      },
      source: {
        findMany: vi.fn().mockResolvedValue(selected.organization.sources),
      },
      $transaction: vi.fn(async (callback: (db: unknown) => Promise<unknown>) => callback(client)),
  };
  return {
    client: client as unknown as PrismaClient,
    findCandidate,
    findScore,
    findSelection,
    findDiagnostic,
    createDiagnostic,
    updateDiagnostic,
    updateDiagnosticMany,
  };
}

const environment = {
  F001_CAMPAIGN_ID: campaignId,
  F001_CANDIDATE_ID: candidateId,
};

describe("F001 acceptance harness", () => {
  it("inspects a normal selected campaign and its persisted provenance without provider calls or writes", async () => {
    const selected = candidate({
      organization: {
        id: organizationId,
        normalizedDomain: "example.test",
        sources: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
        people: [
          {
            id: "77777777-7777-4777-8777-777777777777",
            provenance: "APPLICATION",
            sourceProvider: "apollo",
            sourceType: "PROVIDER",
            sourceUrl: null,
            roles: [{ id: "88888888-8888-4888-8888-888888888888", sourceUrl: null }],
          },
        ],
      },
    });
    const persistedScore = {
      id: scoreId,
      score: 72,
      grade: "B",
      qualified: true,
      recommendedAction: "STANDARD_REVIEW",
      weights: { capabilityMatch: 20 },
      evidenceIds: [],
      createdAt: new Date("2026-10-07T00:00:00Z"),
    };
    const db = database(selected, [persistedScore]);
    const request = vi.fn();

    const result = await runDay5Harness(
      db.client,
      environment,
      "scoring",
      request as unknown as typeof fetch,
    );

    expect(result).toMatchObject({
      mode: "INSPECT",
      businessAcceptance: "UNVERIFIED",
      acceptanceEligible: true,
      campaign: { id: campaignId, weights: { capabilityMatch: 20 } },
      candidate: { id: candidateId, fixtureProvenance: false },
      peopleProvenance: {
        observed: [{ sourceProvider: "apollo", sourceType: "PROVIDER" }],
      },
      before: { score: { id: scoreId } },
      cleanup: { requested: false, deletedRecords: 0 },
    });
    expect(request).not.toHaveBeenCalled();
    expect(db.findCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: candidateId } }),
    );
  });

  it("refuses capability-only and manually reviewed fixtures before calling a provider", async () => {
    const selected = candidate({
      provenance: "ACCEPTANCE_FIXTURE",
      searchStrategyType: "D015_ACCEPTANCE",
      campaign: {
        ...candidate().campaign,
        provenance: "ACCEPTANCE_FIXTURE",
        sectorFitWeight: 0,
        capabilityMatchWeight: 100,
        targetClientFitWeight: 0,
        outsourcingWeight: 0,
        buyingIntentWeight: 0,
        businessMomentumWeight: 0,
        decisionMakerWeight: 0,
        contactConfidenceWeight: 0,
      },
      organization: {
        id: organizationId,
        normalizedDomain: "example.test",
        sources: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
        people: [
          {
            id: "77777777-7777-4777-8777-777777777777",
            provenance: "MANUALLY_REVIEWED",
            sourceProvider: "d016-manually-reviewed-public",
            sourceType: "COMPANY_WEBSITE",
            sourceUrl: "https://example.test/team",
            roles: [],
          },
        ],
      },
    });
    const db = database(selected, [null, null], [null, null]);
    const request = vi.fn();
    const inspected = await runDay5Harness(db.client, environment, "people");
    expect(inspected).toMatchObject({
      acceptanceEligible: false,
      campaign: { capabilityOnly: true },
      candidate: { fixtureProvenance: true },
      peopleProvenance: {
        manuallyReviewedOrFixture: [{ provenance: "MANUALLY_REVIEWED", sourceProvider: "d016-manually-reviewed-public" }],
      },
    });
    await expect(
      runDay5Harness(
        db.client,
        { ...environment, F001_EXECUTE: "1" },
        "people",
        request as unknown as typeof fetch,
      ),
    ).rejects.toThrow("Capability-only scoring fixture");
    expect(request).not.toHaveBeenCalled();
  });

  it("makes cleanup an explicit no-op when the harness owns no records", async () => {
    const unrelatedSelection = { id: "99999999-9999-4999-8999-999999999999" };
    const db = database(candidate(), [null], [unrelatedSelection]);
    const result = await runDay5Harness(
      db.client,
      { ...environment, F001_CLEANUP: "1" },
      "people",
    );
    expect(result).toMatchObject({
      mode: "CLEANUP",
      before: { selection: unrelatedSelection },
      cleanup: {
        requested: true,
        deletedRecords: 0,
        runOwnedRecordIds: [],
      },
    });
  });

  it("requires the exact campaign and candidate pair", async () => {
    const db = database(candidate({ campaignId: organizationId }));
    await expect(runDay5Harness(db.client, environment, "scoring")).rejects.toThrow(
      "Candidate does not belong",
    );
    expect(db.findScore).not.toHaveBeenCalled();
  });

  it("fails closed for an unlabelled test campaign and provider-neutral manually reviewed person", async () => {
    const selected = candidate({
      campaign: { ...candidate().campaign, provenance: "UNKNOWN", name: "F001 integration" },
      organization: {
        id: organizationId,
        normalizedDomain: "example.test",
        sources: [{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }],
        people: [{
          id: "77777777-7777-4777-8777-777777777777",
          provenance: "MANUALLY_REVIEWED",
          sourceProvider: "public-web",
          sourceType: "PUBLIC_WEB",
          sourceUrl: "https://example.test/team",
          roles: [],
        }],
      },
    });
    const db = database(selected, [null, null], [null, null]);
    const request = vi.fn();
    const result = await runDay5Harness(db.client, environment, "people");
    expect(result).toMatchObject({
      acceptanceEligible: false,
      campaign: { provenance: "UNKNOWN" },
      peopleProvenance: { manuallyReviewedOrFixture: [{ provenance: "MANUALLY_REVIEWED" }] },
    });
    await expect(runDay5Harness(db.client, { ...environment, F001_EXECUTE: "1" }, "people", request as unknown as typeof fetch)).rejects.toThrow("Campaign provenance is UNKNOWN");
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a changed candidate before the workflow call", async () => {
    const db = database(candidate(), [null], [null]);
    db.findCandidate.mockResolvedValueOnce(candidate()).mockResolvedValueOnce(candidate({
      status: "REJECTED",
    }));
    const request = vi.fn();
    await expect(runDay5Harness(db.client, { ...environment, F001_EXECUTE: "1", N8N_SERVICE_SECRET: "test-only-secret" }, "scoring", request as unknown as typeof fetch)).rejects.toThrow("changed before execution");
    expect(request).not.toHaveBeenCalled();
  });

  it("shows a stuck research stage and refuses a blind repeat workflow call", async () => {
    const db = database(candidate({ status: "RESEARCHING" }), [null, null], [null, null]);
    const request = vi.fn();
    const inspected = await runDay5Harness(db.client, environment, "scoring");
    expect(inspected).toMatchObject({
      mode: "INSPECT",
      acceptanceEligible: false,
      businessAcceptance: "UNVERIFIED",
      candidate: { id: candidateId, status: "RESEARCHING" },
      before: { score: null, selection: null },
    });
    expect(inspected.reasons).toContain(
      "Candidate is RESEARCHING; a fresh diagnostic dispatch is unsafe until its existing stage is reconciled",
    );
    await expect(runDay5Harness(db.client, {
      ...environment,
      F001_EXECUTE: "1",
    }, "scoring", request as unknown as typeof fetch)).rejects.toThrow("Candidate is RESEARCHING");
    expect(request).not.toHaveBeenCalled();
  });

  it("matches a workflow response to the score persisted by NestJS", async () => {
    const score = { id: scoreId, score: 65, qualified: false };
    const db = database(candidate(), [null, score], [null, null]);
    db.findCandidate.mockResolvedValueOnce(candidate()).mockResolvedValueOnce(candidate())
      .mockResolvedValueOnce(candidate()).mockResolvedValueOnce(candidate({ status: "REJECTED" }));
    const request = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          executionId: "42",
          scoring: {
            id: scoreId,
            leadCandidateId: candidateId,
            candidateStatus: "REJECTED",
            cached: false,
            result: {
              qualified: false,
              grade: "C",
              recommendedAction: "STANDARD_REVIEW",
            },
          },
          people: null,
        }),
        { status: 200 },
      ),
    );
    const result = await runDay5Harness(
      db.client,
      {
        ...environment,
        F001_EXECUTE: "1",
        N8N_SERVICE_SECRET: "test-only-secret",
      },
      "scoring",
      request as unknown as typeof fetch,
    );
    expect(result).toMatchObject({
      mode: "DIAGNOSTIC_RUN",
      businessAcceptance: "UNVERIFIED",
      workflow: {
        executionId: "42",
        scoringId: scoreId,
        candidateStatus: "REJECTED",
        peopleStage: "NOT_RETURNED",
      },
      after: { score },
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(db.createDiagnostic).toHaveBeenCalledTimes(1);
    expect(db.updateDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "VERIFIED", externalRunId: "42", scoreId }),
    }));
  });

  it("surfaces provider refusal without manufacturing score or people data", async () => {
    const db = database(candidate(), [null], [null]);
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
    await expect(
      runDay5Harness(
        db.client,
        {
          ...environment,
          F001_EXECUTE: "1",
          N8N_SERVICE_SECRET: "test-only-secret",
        },
        "people",
        request as unknown as typeof fetch,
      ),
    ).rejects.toThrow("HTTP 429");
    expect(db.findScore).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reports an unknown outcome on timeout without retrying", async () => {
    const db = database(candidate(), [null], [null]);
    const request = vi.fn().mockRejectedValue(new DOMException("Timed out", "TimeoutError"));
    await expect(runDay5Harness(db.client, {
      ...environment,
      F001_EXECUTE: "1",
      N8N_SERVICE_SECRET: "test-only-secret",
    }, "scoring", request as unknown as typeof fetch)).rejects.toThrow("workflow outcome unknown; inspect persisted state before retrying");
    expect(request).toHaveBeenCalledTimes(1);
    expect(db.updateDiagnosticMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "NEEDS_REVIEW", outcome: "RECONCILE_REQUIRED" }),
    }));
  });

  it("reconciles a NEEDS_REVIEW claim from persisted state without dispatching again", async () => {
    const db = database(candidate({ status: "REJECTED" }), [
      { id: scoreId, createdAt: new Date("2026-10-07T00:01:00Z") },
      { id: scoreId, createdAt: new Date("2026-10-07T00:01:00Z") },
    ], [null, null]);
    db.findDiagnostic.mockResolvedValue({
      id: "99999999-9999-4999-8999-999999999999",
      status: "NEEDS_REVIEW",
      externalRunId: "42",
      scoreId,
      candidateUpdatedAt: new Date("2026-10-07T00:00:00Z"),
      createdAt: new Date("2026-10-07T00:00:00Z"),
    });
    const request = vi.fn();
    const result = await runDay5Harness(
      db.client,
      { ...environment, F001_RECONCILE: "1" },
      "scoring",
      request as unknown as typeof fetch,
    );
    expect(result).toMatchObject({
      mode: "RECONCILE",
      businessAcceptance: "UNVERIFIED",
      acceptanceEligible: false,
      diagnosticRun: {
        status: "VERIFIED",
      },
    });
    expect(request).not.toHaveBeenCalled();
    expect(db.updateDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "VERIFIED",
        outcome: "RECONCILED_PERSISTED_RESULT",
      }),
    }));
  });

  it("reconciles a persisted post-claim score when the webhook response was lost", async () => {
    const db = database(candidate({ status: "REJECTED" }), [
      { id: scoreId, createdAt: new Date("2026-10-07T00:01:00Z") },
      { id: scoreId, createdAt: new Date("2026-10-07T00:01:00Z") },
    ], [null, null]);
    db.findDiagnostic.mockResolvedValue({
      id: "99999999-9999-4999-8999-999999999999",
      status: "NEEDS_REVIEW",
      externalRunId: null,
      scoreId: null,
      candidateUpdatedAt: new Date("2026-10-07T00:00:00Z"),
      createdAt: new Date("2026-10-07T00:00:00Z"),
    });
    const request = vi.fn();
    const result = await runDay5Harness(db.client, {
      ...environment, F001_RECONCILE: "1",
    }, "scoring", request as unknown as typeof fetch);
    expect(result).toMatchObject({
      diagnosticRun: { status: "VERIFIED" },
      reasons: ["NestJS result persisted; n8n execution ID was not acknowledged"],
    });
    expect(db.updateDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        scoreId,
        outcome: "RECONCILED_PERSISTED_RESULT_NO_WEBHOOK_ACK",
      }),
    }));
    expect(request).not.toHaveBeenCalled();
  });

  it("does not turn an old score or later candidate mutation into a verified diagnostic", async () => {
    const db = database(candidate({ status: "REJECTED" }), [
      { id: scoreId, createdAt: new Date("2026-10-06T23:59:00Z") },
      { id: scoreId, createdAt: new Date("2026-10-06T23:59:00Z") },
    ], [null, null]);
    db.findDiagnostic.mockResolvedValue({
      id: "99999999-9999-4999-8999-999999999999",
      status: "NEEDS_REVIEW",
      externalRunId: null,
      scoreId: null,
      candidateUpdatedAt: new Date("2026-10-07T00:00:00Z"),
      createdAt: new Date("2026-10-07T00:00:00Z"),
    });
    const result = await runDay5Harness(db.client, {
      ...environment, F001_RECONCILE: "1",
    }, "scoring", vi.fn() as unknown as typeof fetch);
    expect(result).toMatchObject({ diagnosticRun: { status: "NEEDS_REVIEW" } });
    expect(db.updateDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "NEEDS_REVIEW" }),
    }));
  });

  it("does not downgrade an already verified diagnostic on reconciliation", async () => {
    const db = database(candidate({ status: "REJECTED" }), [null], [null]);
    db.findDiagnostic.mockResolvedValue({
      id: "99999999-9999-4999-8999-999999999999",
      status: "VERIFIED",
      externalRunId: "42",
      scoreId,
      candidateUpdatedAt: new Date("2026-10-07T00:00:00Z"),
      createdAt: new Date("2026-10-07T00:00:00Z"),
    });
    const result = await runDay5Harness(db.client, {
      ...environment, F001_RECONCILE: "1",
    }, "scoring", vi.fn() as unknown as typeof fetch);
    expect(result).toMatchObject({ diagnosticRun: { status: "VERIFIED" } });
    expect(db.updateDiagnostic).not.toHaveBeenCalled();
  });

  it("does not dispatch a second request after a durable diagnostic claim", async () => {
    const db = database(candidate(), [null, null], [null, null]);
    let claimed = false;
    db.createDiagnostic.mockImplementation(async ({ data }) => {
      if (claimed) throw new Error("Unique constraint failed on lead_candidate_id");
      claimed = true;
      return { id: data.id };
    });
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 429 }));
    const execute = { ...environment, F001_EXECUTE: "1", N8N_SERVICE_SECRET: "test-only-secret" };
    await expect(runDay5Harness(db.client, execute, "scoring", request as unknown as typeof fetch)).rejects.toThrow("HTTP 429");
    await expect(runDay5Harness(db.client, execute, "people", request as unknown as typeof fetch)).rejects.toThrow("Unique constraint");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("refuses a fresh candidate without stored research documents", async () => {
    const db = database(candidate({ organization: { ...candidate().organization, sources: [] } }));
    const request = vi.fn();
    const inspected = await runDay5Harness(db.client, environment, "scoring");
    expect(inspected).toMatchObject({ acceptanceEligible: false });
    expect(inspected.reasons).toContain("No stored source documents for research; wait for the protected crawl stage");
    await expect(runDay5Harness(db.client, { ...environment, F001_EXECUTE: "1" }, "scoring", request as unknown as typeof fetch)).rejects.toThrow("No stored source documents");
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects malformed or partial workflow output without a second call", async () => {
    const db = database(candidate(), [null], [null]);
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ executionId: "42" }), { status: 200 }));
    await expect(runDay5Harness(db.client, {
      ...environment,
      F001_EXECUTE: "1",
      N8N_SERVICE_SECRET: "test-only-secret",
    }, "people", request as unknown as typeof fetch)).rejects.toThrow("workflow response was invalid");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("records review when the candidate changes while the workflow is running", async () => {
    const db = database(candidate(), [null, { id: scoreId }], [null, null]);
    db.findCandidate.mockResolvedValueOnce(candidate()).mockResolvedValueOnce(candidate())
      .mockResolvedValueOnce(candidate());
    const request = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      expect(body).toMatchObject({ candidateId, diagnosticRunId: expect.any(String), inputHash: expect.any(String) });
      db.findCandidate.mockResolvedValueOnce(candidate({ status: "RESEARCHING" }));
      return new Response(JSON.stringify({
        executionId: "42",
        scoring: {
          id: scoreId,
          leadCandidateId: candidateId,
          candidateStatus: "REJECTED",
          cached: false,
          result: { qualified: false, grade: "C", recommendedAction: "STANDARD_REVIEW" },
        },
      }), { status: 200 });
    });
    await expect(runDay5Harness(db.client, {
      ...environment,
      F001_EXECUTE: "1",
      N8N_SERVICE_SECRET: "test-only-secret",
    }, "scoring", request as unknown as typeof fetch)).rejects.toThrow("persisted candidate does not match");
    expect(request).toHaveBeenCalledTimes(1);
    expect(db.updateDiagnosticMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "NEEDS_REVIEW" }),
    }));
  });

  it("records review when source evidence changes during the workflow", async () => {
    const db = database(candidate(), [null, { id: scoreId }], [null, null]);
    db.findCandidate.mockResolvedValueOnce(candidate()).mockResolvedValueOnce(candidate())
      .mockResolvedValueOnce(candidate()).mockResolvedValueOnce(candidate({ status: "REJECTED" }));
    (db.client.source.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      executionId: "42",
      scoring: {
        id: scoreId,
        leadCandidateId: candidateId,
        candidateStatus: "REJECTED",
        cached: false,
        result: { qualified: false, grade: "C", recommendedAction: "STANDARD_REVIEW" },
      },
    }), { status: 200 }));
    await expect(runDay5Harness(db.client, {
      ...environment,
      F001_EXECUTE: "1",
      N8N_SERVICE_SECRET: "test-only-secret",
    }, "scoring", request as unknown as typeof fetch)).rejects.toThrow("sources changed during execution");
    expect(db.updateDiagnosticMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "NEEDS_REVIEW" }),
    }));
  });

  it("rejects people added during execution that have no application provenance", async () => {
    const db = database(candidate(), [null, { id: scoreId }], [null, null]);
    db.findCandidate.mockResolvedValueOnce(candidate()).mockResolvedValueOnce(candidate())
      .mockResolvedValueOnce(candidate()).mockResolvedValueOnce(candidate({ status: "QUALIFIED" }));
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      executionId: "42",
      scoring: {
        id: scoreId,
        leadCandidateId: candidateId,
        candidateStatus: "QUALIFIED",
        cached: false,
        result: { qualified: true, grade: "B", recommendedAction: "STANDARD_REVIEW" },
      },
      people: { status: "PARTIAL" },
    }), { status: 200 }));
    const personFindMany = (db.client.person.findMany as ReturnType<typeof vi.fn>);
    personFindMany.mockResolvedValue([{
      id: "77777777-7777-4777-8777-777777777777",
      provenance: "UNKNOWN",
      sourceProvider: "public-web",
      sourceType: "PUBLIC_WEB",
      sourceUrl: null,
      roles: [],
    }]);
    const result = await runDay5Harness(db.client, {
      ...environment,
      F001_EXECUTE: "1",
      N8N_SERVICE_SECRET: "test-only-secret",
    }, "people", request as unknown as typeof fetch);
    expect(result).toMatchObject({
      acceptanceEligible: false,
      businessAcceptance: "UNVERIFIED",
      workflow: { peopleStage: "RETURNED" },
      peopleProvenance: { manuallyReviewedOrFixture: [{ provenance: "UNKNOWN" }] },
    });
  });
});
