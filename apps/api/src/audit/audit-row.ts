import { Prisma } from "@tcpl-marketer/database";
import { z } from "zod";

import { currentCorrelation } from "../common/correlation/correlation-context.js";
import { redact } from "../common/redaction/redactor.js";
import { AUDIT_EVENTS, isAuditAction, type AuditEntry } from "./audit-events.js";

export class AuditEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuditEntryError";
  }
}

/**
 * Validates an entry against the closed catalogue and returns the row to
 * persist, redacted and stamped with the current correlation ID and campaign.
 * Shared by the Nest service and standalone scripts so neither can bypass it.
 */
export function buildAuditRow(entry: AuditEntry): Prisma.AuditLogUncheckedCreateInput {
  const action: string = entry.action;
  if (!isAuditAction(action)) {
    throw new AuditEntryError(`Unknown audit action ${action}`);
  }
  const definition = AUDIT_EVENTS[action];
  const parsed = definition.schema.safeParse(entry.metadata ?? {});
  if (!parsed.success) {
    throw new AuditEntryError(
      `Invalid metadata for audit action ${action}: ${parsed.error.issues
        .map((issue) => issue.path.join(".") || issue.message)
        .join(", ")}`,
    );
  }
  const trace = currentCorrelation();
  const campaignId = entry.campaignId ?? trace?.campaignId;
  if (campaignId !== undefined && !z.uuid().safeParse(campaignId).success) {
    throw new AuditEntryError("campaignId must be a UUID");
  }
  const metadata = redact(parsed.data) as Record<string, unknown>;
  return {
    action,
    resourceType: definition.resourceType,
    resourceId: entry.resourceId?.slice(0, 320) ?? null,
    actorUserId: entry.actorUserId ?? null,
    campaignId: campaignId ?? null,
    correlationId: entry.correlationId ?? trace?.correlationId ?? null,
    metadata:
      Object.keys(metadata).length > 0
        ? (metadata as Prisma.InputJsonObject)
        : Prisma.JsonNull,
  };
}
