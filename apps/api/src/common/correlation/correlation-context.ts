import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import type { IncomingMessage, ServerResponse } from "node:http";

/** Header carried between the browser, NestJS and n8n so one run can be traced. */
export const CORRELATION_HEADER = "x-correlation-id";

/** Visible, bounded characters only; anything else could forge or flood log lines. */
const VALID_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/;

export interface CorrelationStore {
  correlationId: string;
  campaignId?: string;
  stageRunId?: string;
  /** Attempt number of the stage run that holds the lease; part of the provider call key. */
  stageAttempt?: number;
}

const storage = new AsyncLocalStorage<CorrelationStore>();

export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === "string" && VALID_CORRELATION_ID.test(value);
}

/** Keeps a well-formed incoming ID, otherwise issues a new one. */
export function resolveCorrelationId(candidate: unknown): string {
  const first = Array.isArray(candidate) ? candidate[0] : candidate;
  return isValidCorrelationId(first) ? first : randomUUID();
}

export function runWithCorrelation<T>(
  correlationId: string,
  work: () => T,
  extra: Omit<CorrelationStore, "correlationId"> = {},
): T {
  return storage.run({ correlationId, ...extra }, work);
}

export function currentCorrelation(): CorrelationStore | undefined {
  return storage.getStore();
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/** Adds the campaign to the active trace so later logs and audit rows carry it. */
export function bindCampaign(campaignId: string): void {
  const store = storage.getStore();
  if (store) store.campaignId = campaignId;
}

export function bindStageRun(stageRunId: string, attempt?: number): void {
  const store = storage.getStore();
  if (!store) return;
  store.stageRunId = stageRunId;
  if (attempt !== undefined) store.stageAttempt = attempt;
}

/**
 * Express-compatible middleware. It validates (or issues) the correlation ID,
 * echoes it on the response and holds it for everything the request touches.
 * It writes the accepted value back to the request header so the HTTP logger
 * uses exactly the same ID.
 */
export function correlationMiddleware(
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
): void {
  const correlationId = resolveCorrelationId(request.headers[CORRELATION_HEADER]);
  request.headers[CORRELATION_HEADER] = correlationId;
  response.setHeader(CORRELATION_HEADER, correlationId);
  runWithCorrelation(correlationId, next);
}
