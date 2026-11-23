import {
  SERVICE_CALLERS,
  type ServiceCallerId,
  type ServiceScope,
} from "@tcpl-marketer/orchestration-contracts";

export const MIN_SERVICE_SECRET_LENGTH = 32;
const DEFAULT_MAX_SKEW_SECONDS = 300;
const MIN_SKEW_SECONDS = 10;
const MAX_SKEW_SECONDS = 900;

export interface ResolvedServiceCaller {
  id: ServiceCallerId;
  scopes: readonly ServiceScope[];
  /** Current secret first, then the rotating-out one when present. */
  secrets: string[];
}

export function readMaxSkewSeconds(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment.SERVICE_AUTH_MAX_SKEW_SECONDS;
  if (raw === undefined || raw === "") return DEFAULT_MAX_SKEW_SECONDS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_SKEW_SECONDS || value > MAX_SKEW_SECONDS) {
    throw new Error(
      `SERVICE_AUTH_MAX_SKEW_SECONDS must be an integer from ${MIN_SKEW_SECONDS} to ${MAX_SKEW_SECONDS}`,
    );
  }
  return value;
}

/** A nonce must outlive every timestamp that could still be accepted. */
export function replayRetentionSeconds(maxSkewSeconds: number): number {
  return maxSkewSeconds * 2 + 60;
}

export function resolveServiceCaller(
  id: ServiceCallerId,
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedServiceCaller {
  const definition = SERVICE_CALLERS[id];
  const current = environment[definition.secretEnv];
  const previous = environment[`${definition.secretEnv}_PREVIOUS`];
  return {
    id,
    scopes: definition.scopes,
    secrets: [current, previous].filter((secret): secret is string => Boolean(secret)),
  };
}

export function anyServiceCallerConfigured(environment: NodeJS.ProcessEnv = process.env): boolean {
  return (Object.keys(SERVICE_CALLERS) as ServiceCallerId[]).some(
    (id) => resolveServiceCaller(id, environment).secrets.length > 0,
  );
}

/**
 * Startup check. A weak, reused or misplaced secret is always an error. A
 * missing secret is an error everywhere except development and test, where
 * that caller simply cannot authenticate. Messages name variables, never values.
 */
export function validateServiceAuthEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): { missing: string[] } {
  readMaxSkewSeconds(environment);
  const lenient = environment.NODE_ENV === "development" || environment.NODE_ENV === "test";
  const missing: string[] = [];
  const owners = new Map<string, string>();
  const webhookSecret = environment.N8N_SERVICE_SECRET;

  for (const definition of Object.values(SERVICE_CALLERS)) {
    const currentName = definition.secretEnv;
    const previousName = `${currentName}_PREVIOUS`;
    if (!environment[currentName]) missing.push(currentName);
    if (environment[previousName] && !environment[currentName]) {
      throw new Error(`${previousName} is set without ${currentName}`);
    }
    for (const name of [currentName, previousName]) {
      const value = environment[name];
      if (!value) continue;
      if (value.length < MIN_SERVICE_SECRET_LENGTH) {
        throw new Error(`${name} must be at least ${MIN_SERVICE_SECRET_LENGTH} characters`);
      }
      if (value === webhookSecret) {
        throw new Error(`${name} must differ from N8N_SERVICE_SECRET`);
      }
      const owner = owners.get(value);
      if (owner) throw new Error(`${name} must differ from ${owner}`);
      owners.set(value, name);
    }
  }
  if (missing.length > 0 && !lenient) {
    throw new Error(`Missing service secrets: ${missing.join(", ")}`);
  }
  // This key signs the webhook tokens sent to n8n.
  if (!lenient && (webhookSecret?.length ?? 0) < MIN_SERVICE_SECRET_LENGTH) {
    throw new Error(`N8N_SERVICE_SECRET must be at least ${MIN_SERVICE_SECRET_LENGTH} characters`);
  }
  return { missing };
}
