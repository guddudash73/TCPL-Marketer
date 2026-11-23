import { createHash, createHmac, randomUUID } from "node:crypto";

/**
 * Service request signing shared by the NestJS verifier, tests and scripts
 * (PH1-02b). The n8n workflows build the same canonical string in an expression;
 * docs/architecture/service-authentication.md shows it.
 */

export const SERVICE_SIGNATURE_VERSION = "TCPL-HMAC-SHA256-V2";

export const SERVICE_AUTH_HEADERS = {
  keyId: "x-service-key-id",
  timestamp: "x-service-timestamp",
  requestId: "x-service-request-id",
  signature: "x-service-signature",
} as const;

/** Headers that change what a handler does, so they are covered by the signature. */
export const SERVICE_BOUND_HEADERS = {
  diagnosticRunId: "x-f001-diagnostic-run-id",
  inputHash: "x-f001-input-hash",
} as const;

/** SHA-256 of zero bytes: the body hash of a request that has no body. */
export const EMPTY_BODY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export const SERVICE_SCOPES = [
  "campaign.context.read",
  "campaign.discovery.prepare",
  "orchestration.dispatch",
  "candidate.research.run",
  "candidate.score.run",
  "candidate.score.read",
  "candidate.people.select",
  "candidate.people.read",
  "organization.profile.read",
  "organization.company_fit.read",
  "organization.company_fit.write",
] as const;

export type ServiceScope = (typeof SERVICE_SCOPES)[number];

export interface ServiceCallerDefinition {
  /** Environment variable holding the current secret; `<name>_PREVIOUS` holds the rotating-out one. */
  secretEnv: string;
  scopes: readonly ServiceScope[];
}

/** The closed list of machine callers and exactly what each may call. */
export const SERVICE_CALLERS = {
  "n8n-campaign-start": {
    secretEnv: "SERVICE_SECRET_N8N_CAMPAIGN_START",
    scopes: ["campaign.context.read", "campaign.discovery.prepare"],
  },
  "n8n-company-research": {
    secretEnv: "SERVICE_SECRET_N8N_COMPANY_RESEARCH",
    scopes: ["candidate.research.run", "candidate.score.run", "candidate.people.select"],
  },
  "n8n-outbox-dispatch": {
    secretEnv: "SERVICE_SECRET_N8N_OUTBOX_DISPATCH",
    scopes: ["orchestration.dispatch"],
  },
  "internal-tooling": {
    secretEnv: "SERVICE_SECRET_INTERNAL_TOOLING",
    scopes: [
      "candidate.research.run",
      "candidate.score.read",
      "candidate.people.read",
      "organization.profile.read",
      "organization.company_fit.read",
      "organization.company_fit.write",
    ],
  },
} as const satisfies Record<string, ServiceCallerDefinition>;

export type ServiceCallerId = keyof typeof SERVICE_CALLERS;

export function isServiceCallerId(value: unknown): value is ServiceCallerId {
  return typeof value === "string" && Object.hasOwn(SERVICE_CALLERS, value);
}

const VALID_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export function isValidServiceRequestId(value: unknown): value is string {
  return typeof value === "string" && VALID_REQUEST_ID.test(value);
}

export function sha256Hex(body: string | Uint8Array = ""): string {
  return createHash("sha256").update(body).digest("hex");
}

export interface ServiceCanonicalInput {
  keyId: string;
  timestamp: string;
  requestId: string;
  method: string;
  /** Path and query exactly as sent on the request line. */
  path: string;
  bodySha256: string;
  diagnosticRunId?: string | undefined;
  inputHash?: string | undefined;
}

export function buildServiceCanonicalString(input: ServiceCanonicalInput): string {
  return [
    SERVICE_SIGNATURE_VERSION,
    input.keyId,
    input.timestamp,
    input.requestId,
    input.method.toUpperCase(),
    input.path,
    input.bodySha256,
    input.diagnosticRunId ?? "",
    input.inputHash ?? "",
  ].join("\n");
}

export function computeServiceSignature(secret: string, input: ServiceCanonicalInput): string {
  return createHmac("sha256", secret).update(buildServiceCanonicalString(input)).digest("hex");
}

export interface SignServiceRequestInput {
  keyId: string;
  secret: string;
  method: string;
  path: string;
  /** The exact bytes that will be sent. */
  body?: string | Uint8Array | undefined;
  requestId: string;
  timestamp?: string | undefined;
  diagnosticRunId?: string | undefined;
  inputHash?: string | undefined;
}

/** Returns the headers for one request. A request ID must never be reused. */
export function signServiceRequest(input: SignServiceRequestInput): Record<string, string> {
  const timestamp = input.timestamp ?? Date.now().toString();
  const signature = computeServiceSignature(input.secret, {
    keyId: input.keyId,
    timestamp,
    requestId: input.requestId,
    method: input.method,
    path: input.path,
    bodySha256: input.body === undefined ? EMPTY_BODY_SHA256 : sha256Hex(input.body),
    diagnosticRunId: input.diagnosticRunId,
    inputHash: input.inputHash,
  });
  return {
    [SERVICE_AUTH_HEADERS.keyId]: input.keyId,
    [SERVICE_AUTH_HEADERS.timestamp]: timestamp,
    [SERVICE_AUTH_HEADERS.requestId]: input.requestId,
    [SERVICE_AUTH_HEADERS.signature]: signature,
    ...(input.diagnosticRunId ? { [SERVICE_BOUND_HEADERS.diagnosticRunId]: input.diagnosticRunId } : {}),
    ...(input.inputHash ? { [SERVICE_BOUND_HEADERS.inputHash]: input.inputHash } : {}),
  };
}

/** How long a NestJS-to-n8n webhook token stays valid. */
export const N8N_WEBHOOK_TOKEN_TTL_SECONDS = 60;
const MAX_N8N_WEBHOOK_TOKEN_TTL_SECONDS = 300;

export interface N8nWebhookTokenOptions {
  /** The webhook path this token was issued for. */
  subject: string;
  ttlSeconds?: number;
  /** Milliseconds since the epoch. */
  now?: number;
}

/**
 * A short-lived HS256 JWT for calling an n8n webhook. n8n stores incoming
 * headers in its execution history, so the value sent must be useless soon
 * after the call; the signing secret itself is never sent.
 */
export function createN8nWebhookToken(secret: string, options: N8nWebhookTokenOptions): string {
  const ttlSeconds = options.ttlSeconds ?? N8N_WEBHOOK_TOKEN_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_N8N_WEBHOOK_TOKEN_TTL_SECONDS) {
    throw new Error(`Webhook token lifetime must be 1 to ${MAX_N8N_WEBHOOK_TOKEN_TTL_SECONDS} seconds`);
  }
  if (!secret) throw new Error("A webhook signing secret is required");
  const issuedAt = Math.floor((options.now ?? Date.now()) / 1_000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: "tcpl-api",
    sub: options.subject,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
    jti: randomUUID(),
  })}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
}
