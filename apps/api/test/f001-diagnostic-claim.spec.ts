import { ConflictException } from "@nestjs/common";
import type { PrismaClient } from "@tcpl-marketer/database";
import { describe, expect, it, vi } from "vitest";

import { assertDiagnosticClaim } from "../src/acceptance/diagnostic-claim.js";
import { diagnosticSnapshotHash } from "../src/acceptance/diagnostic-snapshot.js";

const candidateId = "22222222-2222-4222-8222-222222222222";
const runId = "33333333-3333-4333-8333-333333333333";
const at = new Date("2026-10-07T00:00:00Z");

function candidate() {
  return {
    id: candidateId,
    campaignId: "11111111-1111-4111-8111-111111111111",
    organizationId: "44444444-4444-4444-8444-444444444444",
    status: "DISCOVERED",
    provenance: "APPLICATION",
    updatedAt: at,
    campaign: {
      name: "Normal campaign",
      status: "RUNNING",
      provenance: "APPLICATION",
      updatedAt: at,
      capabilities: [{ capabilityId: "55555555-5555-4555-8555-555555555555" }],
      targets: [{ targetClientProfileId: "66666666-6666-4666-8666-666666666666" }],
    },
    organization: {
      name: "Example Company",
      sources: [{
        id: "77777777-7777-4777-8777-777777777777",
        contentHash: "first", capturedAt: at,
        url: "https://example.test/services", title: "Services",
        webDocument: { text: "Original document" },
      }],
      people: [{
        id: "88888888-8888-4888-8888-888888888888",
        provenance: "APPLICATION",
        sourceProvider: "public",
        sourceUrl: "https://example.test/team",
        fullName: "Example Person",
        normalizedName: "example person",
        confidence: 0.8,
        updatedAt: at,
        roles: [{
          id: "99999999-9999-4999-8999-999999999999",
          sourceUrl: "https://example.test/team",
          title: "Director",
          normalizedTitle: "director",
          seniority: "Director",
          confidence: 0.8,
          updatedAt: at,
        }],
      }],
    },
  };
}

function database(snapshot = candidate(), claimed = true) {
  const hash = diagnosticSnapshotHash(candidate());
  const findUnique = vi.fn().mockImplementation(async ({ where }) => {
    if (where.id === runId || where.leadCandidateId === candidateId) {
      return claimed ? {
        id: runId,
        leadCandidateId: candidateId,
        status: "CLAIMED",
        inputHash: hash,
        candidateUpdatedAt: at,
      } : null;
    }
    return null;
  });
  const findCandidate = vi.fn().mockResolvedValue(snapshot);
  return {
    client: {
      acceptanceDiagnosticRun: { findUnique },
      leadCandidate: { findUnique: findCandidate },
    } as unknown as PrismaClient,
    findUnique,
    findCandidate,
    hash,
  };
}

describe("F001 diagnostic claim at protected domain entry", () => {
  it("allows the ordinary no-claim path only when no diagnostic exists", async () => {
    const ordinary = database(candidate(), false);
    expect(await assertDiagnosticClaim(ordinary.client, candidateId, undefined, undefined, true)).toBeUndefined();
    expect(ordinary.findCandidate).not.toHaveBeenCalled();
    const claimed = database();
    await expect(assertDiagnosticClaim(claimed.client, candidateId, undefined, undefined, true))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects either partial header before any provider-facing work", async () => {
    const db = database();
    await expect(assertDiagnosticClaim(db.client, candidateId, runId, undefined, true))
      .rejects.toBeInstanceOf(ConflictException);
    await expect(assertDiagnosticClaim(db.client, candidateId, undefined, db.hash, true))
      .rejects.toBeInstanceOf(ConflictException);
    expect(db.findCandidate).not.toHaveBeenCalled();
  });

  it("accepts the exact claim and unchanged persisted snapshot", async () => {
    const db = database();
    expect(await assertDiagnosticClaim(db.client, candidateId, runId, db.hash, true))
      .toEqual({ candidateUpdatedAt: at });
  });

  it.each([
    ["campaign", (snapshot: ReturnType<typeof candidate>) => { snapshot.campaign.name = "Changed"; }],
    ["source", (snapshot: ReturnType<typeof candidate>) => { snapshot.organization.sources[0]!.contentHash = "changed"; }],
    ["source text", (snapshot: ReturnType<typeof candidate>) => { snapshot.organization.sources[0]!.webDocument.text = "Changed"; }],
    ["organization", (snapshot: ReturnType<typeof candidate>) => { snapshot.organization.name = "Changed"; }],
    ["person", (snapshot: ReturnType<typeof candidate>) => { snapshot.organization.people[0]!.fullName = "Changed"; }],
    ["role", (snapshot: ReturnType<typeof candidate>) => { snapshot.organization.people[0]!.roles[0]!.title = "Changed"; }],
  ])("rejects a %s mutation after claim before research", async (_label, mutate) => {
    const changed = candidate();
    mutate(changed);
    const db = database(changed);
    await expect(assertDiagnosticClaim(db.client, candidateId, runId, db.hash, true))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it("rejects stale, mismatched, and reconciled claims", async () => {
    const db = database();
    await expect(assertDiagnosticClaim(db.client, candidateId, runId, "bad", true))
      .rejects.toBeInstanceOf(ConflictException);
    db.findUnique.mockResolvedValueOnce({ leadCandidateId: candidateId, status: "NEEDS_REVIEW", inputHash: db.hash });
    await expect(assertDiagnosticClaim(db.client, candidateId, runId, db.hash, true))
      .rejects.toBeInstanceOf(ConflictException);
  });
});
