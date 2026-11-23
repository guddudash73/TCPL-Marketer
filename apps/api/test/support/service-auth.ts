import { randomUUID } from "node:crypto";

import {
  SERVICE_CALLERS,
  signServiceRequest,
  type ServiceCallerId,
} from "@tcpl-marketer/orchestration-contracts";

/** Test-only values. Each caller has its own, as the verifier requires. */
export const TEST_SERVICE_SECRETS: Record<ServiceCallerId, string> = {
  "n8n-campaign-start": "test-only-campaign-start-secret-0123456789",
  "n8n-company-research": "test-only-company-research-secret-0123456789",
  "n8n-outbox-dispatch": "test-only-outbox-dispatch-secret-0123456789",
  "internal-tooling": "test-only-internal-tooling-secret-0123456789",
};

export function installTestServiceSecrets(environment: NodeJS.ProcessEnv = process.env): void {
  for (const [id, secret] of Object.entries(TEST_SERVICE_SECRETS)) {
    environment[SERVICE_CALLERS[id as ServiceCallerId].secretEnv] = secret;
  }
}

/** The caller that production would use for this route. */
export function callerForRoute(method: string, path: string): ServiceCallerId {
  const route = path.split("?")[0] ?? "";
  if (route === "/internal/orchestration/dispatch") return "n8n-outbox-dispatch";
  if (route.startsWith("/internal/campaigns/")) return "n8n-campaign-start";
  if (method === "POST" && /\/(research|score|decision-makers)$/.test(route)) {
    return "n8n-company-research";
  }
  return "internal-tooling";
}

export interface TestSignOptions {
  caller?: ServiceCallerId;
  secret?: string;
  body?: string;
  requestId?: string;
  timestamp?: string;
  diagnosticRunId?: string;
  inputHash?: string;
}

/** Headers for one signed request, with a fresh request ID unless one is given. */
export function serviceHeaders(
  method: string,
  path: string,
  options: TestSignOptions = {},
): Record<string, string> {
  const caller = options.caller ?? callerForRoute(method, path);
  return signServiceRequest({
    keyId: caller,
    secret: options.secret ?? TEST_SERVICE_SECRETS[caller],
    method,
    path,
    body: options.body,
    requestId: options.requestId ?? `test-${randomUUID()}`,
    timestamp: options.timestamp,
    diagnosticRunId: options.diagnosticRunId,
    inputHash: options.inputHash,
  });
}
