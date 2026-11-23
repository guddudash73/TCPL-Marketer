import { z } from "zod";

/**
 * The closed audit event catalogue (PH1-02a). An action that is not listed here
 * cannot be written, and its metadata must match the schema, so audit rows stay
 * structured, reviewable and free of arbitrary content.
 *
 * To add an event: add it here with its resource type, whether it is critical
 * (written in the same transaction as the change it records) and a strict
 * metadata schema. Rows that own an event (send, reply, assignment, ...) add
 * their emitter and prove it in their own acceptance.
 */

export interface AuditEventDefinition<S extends z.ZodType = z.ZodType> {
  resourceType: string;
  /** Critical events are written in the same transaction as the change; a failed write fails the action. */
  critical: boolean;
  schema: S;
}

function define<S extends z.ZodType>(
  resourceType: string,
  critical: boolean,
  schema: S,
): AuditEventDefinition<S> {
  return { resourceType, critical, schema };
}

const text = z.string().min(1).max(500);
const none = z.object({}).strict();
const requestInfo = z
  .object({
    ipAddress: z.string().max(64).optional(),
    userAgent: z.string().max(300).optional(),
  })
  .strict();

const CONFIGURATION_RESOURCES = {
  sector: "sector",
  capability: "service_capability",
  deliverable: "capability_deliverable",
  target_profile: "target_client_profile",
  decision_maker: "decision_maker_profile",
} as const;

type ConfigurationEntity = keyof typeof CONFIGURATION_RESOURCES;
type ConfigurationVerb = "created" | "updated" | "deleted";
export type ConfigurationAuditAction =
  `configuration.${ConfigurationEntity}.${ConfigurationVerb}`;

const configurationEvents = Object.fromEntries(
  (Object.keys(CONFIGURATION_RESOURCES) as ConfigurationEntity[]).flatMap(
    (entity) =>
      (["created", "updated", "deleted"] as const).map((verb) => [
        `configuration.${entity}.${verb}`,
        define(CONFIGURATION_RESOURCES[entity], true, none),
      ]),
  ),
) as Record<ConfigurationAuditAction, AuditEventDefinition<typeof none>>;

export const AUDIT_EVENTS = {
  ...configurationEvents,

  "auth.login.failed": define("user", false, requestInfo),
  "auth.login.succeeded": define("user", false, requestInfo),
  "auth.logout": define("user", false, requestInfo),
  "admin.seed.created": define("user", true, z.object({ passwordChanged: z.boolean() }).strict()),
  "admin.seed.verified": define("user", true, z.object({ passwordChanged: z.boolean() }).strict()),

  "campaign.created": define(
    "campaign",
    true,
    z.object({ automationMode: text, status: text }).strict(),
  ),
  "campaign.updated": define("campaign", true, none),
  "campaign.deleted": define("campaign", true, none),
  "campaign.start_requested": define(
    "campaign",
    true,
    z.object({ outboxEventId: z.uuid(), automationRunId: z.uuid() }).strict(),
  ),
  "campaign.started": define(
    "campaign",
    true,
    z.object({ outboxEventId: z.uuid(), automationRunId: z.uuid().nullable() }).strict(),
  ),

  "orchestration.event_dead_lettered": define(
    "outbox_event",
    true,
    z
      .object({
        eventType: text,
        aggregateId: z.uuid(),
        attempts: z.number().int().min(0),
        reason: z.string().max(2_000),
      })
      .strict(),
  ),

  "stage.transitioned": define(
    "stage_run",
    true,
    z
      .object({
        stage: text,
        from: z.string().max(64).nullable(),
        to: text,
        attempt: z.number().int().min(0),
        outcome: z.string().max(128).nullable().optional(),
        reason: z.string().max(2_000).nullable().optional(),
      })
      .strict(),
  ),

  "provider.call": define(
    "provider",
    false,
    z
      .object({
        operation: text,
        status: z.enum(["SUCCEEDED", "FAILED"]),
        durationMs: z.number().int().min(0),
        model: z.string().max(128).optional(),
        inputTokens: z.number().int().min(0).optional(),
        outputTokens: z.number().int().min(0).optional(),
        providerResponseId: z.string().max(255).optional(),
        errorName: z.string().max(128).optional(),
      })
      .strict(),
  ),

  "operator.retry_requested": define(
    "stage_run",
    true,
    z
      .object({
        stage: text,
        reason: z.string().min(1).max(2_000),
        originalIdempotencyKey: z.string().max(255).optional(),
      })
      .strict(),
  ),
  "operator.dead_letter_requeued": define(
    "outbox_event",
    true,
    z.object({ eventType: text, reason: z.string().min(1).max(2_000) }).strict(),
  ),
  "operator.dead_letter_cleared": define(
    "outbox_event",
    true,
    z.object({ eventType: text, reason: z.string().min(1).max(2_000) }).strict(),
  ),

  "service_auth.rejected": define(
    "service_request",
    false,
    z
      .object({
        reason: text,
        caller: z.string().min(1).max(64),
        scope: z.string().max(64).nullable(),
        method: z.string().min(1).max(16),
        path: z.string().max(256),
        suppressedSinceLastRow: z.number().int().min(0),
      })
      .strict(),
  ),

  // Reserved: schemas exist now, the emitting rows (send, reply, assignment) add the callers.
  "email.sent": define("email", true, z.object({ mode: text, overridden: z.boolean() }).strict()),
  "reply.received": define("reply", true, z.object({ classification: z.string().max(64).optional() }).strict()),
  "lead.assigned": define("lead", true, z.object({ assigneeId: z.uuid() }).strict()),
} as const satisfies Record<string, AuditEventDefinition>;

export type AuditAction = keyof typeof AUDIT_EVENTS;

export type AuditMetadata<A extends AuditAction> = z.input<
  (typeof AUDIT_EVENTS)[A]["schema"]
>;

export type AuditEntry<A extends AuditAction = AuditAction> = {
  action: A;
  resourceId?: string | undefined;
  actorUserId?: string | null | undefined;
  /** Falls back to the campaign bound to the current trace. */
  campaignId?: string | undefined;
  /** Falls back to the current request's correlation ID. */
  correlationId?: string | undefined;
} & (Record<never, never> extends AuditMetadata<A>
  ? { metadata?: AuditMetadata<A> | undefined }
  : { metadata: AuditMetadata<A> });

export function isAuditAction(value: string): value is AuditAction {
  return Object.hasOwn(AUDIT_EVENTS, value);
}
