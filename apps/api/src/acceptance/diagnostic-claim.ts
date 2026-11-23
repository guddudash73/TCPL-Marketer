import { ConflictException } from "@nestjs/common";
import type { PrismaClient } from "@tcpl-marketer/database";

import { diagnosticCandidateInclude, diagnosticSnapshotHash } from "./diagnostic-snapshot.js";

export async function assertDiagnosticClaim(
  database: PrismaClient,
  candidateId: string,
  diagnosticRunId: string | undefined,
  inputHash: string | undefined,
  verifyInputSnapshot = false,
): Promise<{ candidateUpdatedAt: Date } | undefined> {
  if (!diagnosticRunId && !inputHash) {
    const existing = await database.acceptanceDiagnosticRun.findUnique({
      where: { leadCandidateId: candidateId },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        "F001 diagnostic claim exists; signed workflow requests must include both claim headers",
      );
    }
    return undefined;
  }
  if (!diagnosticRunId || !inputHash) {
    throw new ConflictException("Both F001 diagnostic claim headers are required");
  }
  const run = await database.acceptanceDiagnosticRun.findUnique({
    where: { id: diagnosticRunId },
    select: {
      leadCandidateId: true,
      status: true,
      inputHash: true,
      candidateUpdatedAt: true,
    },
  });
  if (
    !run ||
    run.leadCandidateId !== candidateId ||
    run.status !== "CLAIMED" ||
    run.inputHash !== inputHash
  ) {
    throw new ConflictException(
      "F001 diagnostic claim is missing, stale or already reconciled",
    );
  }
  if (verifyInputSnapshot) {
    const candidate = await database.leadCandidate.findUnique({
      where: { id: candidateId },
      include: diagnosticCandidateInclude,
    });
    if (!candidate || diagnosticSnapshotHash(candidate) !== inputHash) {
      throw new ConflictException(
        "F001 diagnostic inputs changed before research; reconcile without a provider call",
      );
    }
  }
  return { candidateUpdatedAt: run.candidateUpdatedAt };
}
