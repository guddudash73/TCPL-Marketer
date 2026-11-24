import { HttpException } from "@nestjs/common";

import { ProviderBudgetError } from "./provider-budget.error.js";

/**
 * The shared outcome mapper (PH1-03b). A stage, an endpoint or a later stage
 * service passes any error it caught from a provider call and gets back a stable
 * outcome, or null when the error is not a spend, rate, credit or timeout case
 * and must keep its existing handling.
 */
export type ProviderOutcomeCode =
  | "BUDGET_EXHAUSTED"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "CREDIT_EXHAUSTED"
  | "CAMPAIGN_NOT_ACTIVE"
  | "ALREADY_SETTLED";

export interface ProviderOutcome {
  code: ProviderOutcomeCode;
  /** True when trying again later can succeed without anyone changing configuration or money. */
  retryable: boolean;
  retryAfterSeconds?: number;
  /** Generic, safe to store and to return to a caller. Never contains a provider response body. */
  reason: string;
  /** The HTTP status an endpoint answers with for this outcome. */
  httpStatus: number;
}

/**
 * How a stage run ends for an outcome that is not retried automatically:
 * an exhausted budget waits for the owner (REVIEW_REQUIRED, resumed by the
 * operator-retry transition), exhausted provider credit is a failure that an
 * operator retries after the account is topped up.
 */
export function stageEndFor(outcome: ProviderOutcome): { status: "REVIEW_REQUIRED" | "FAILED"; outcome: string } | null {
  if (outcome.code === "BUDGET_EXHAUSTED") return { status: "REVIEW_REQUIRED", outcome: "BUDGET_EXHAUSTED" };
  if (outcome.code === "CREDIT_EXHAUSTED") return { status: "FAILED", outcome: "CREDIT_EXHAUSTED" };
  return null;
}

const DEFAULT_RETRY_SECONDS = 30;
const MAX_CHAIN_DEPTH = 5;
const TIMEOUT_NAMES = new Set(["APIConnectionTimeoutError", "TimeoutError", "AbortError"]);
const TIMEOUT_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);

/** The error and its causes, innermost last, bounded so a cyclic cause cannot loop. */
function chain(error: unknown): unknown[] {
  const seen: unknown[] = [];
  let current: unknown = error;
  while (current !== undefined && current !== null && seen.length < MAX_CHAIN_DEPTH && !seen.includes(current)) {
    seen.push(current);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return seen;
}

function field(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[name] : undefined;
}

/**
 * The HTTP status the provider itself answered with. A NestJS exception that an
 * adapter wrapped around it has its own status and is skipped.
 */
export function providerHttpStatus(error: unknown): number | undefined {
  for (const link of chain(error)) {
    if (link instanceof HttpException) continue;
    const status = field(link, "status");
    if (typeof status === "number" && Number.isInteger(status)) return status;
  }
  return undefined;
}

function retryAfterSeconds(error: unknown): number {
  for (const link of chain(error)) {
    const headers = field(link, "headers");
    let raw: unknown;
    if (typeof headers === "object" && headers !== null) {
      const getter = (headers as { get?: unknown }).get;
      raw = typeof getter === "function" ? (getter as (name: string) => unknown).call(headers, "retry-after") : field(headers, "retry-after");
    }
    const seconds = typeof raw === "string" || typeof raw === "number" ? Number(raw) : Number.NaN;
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(3_600, Math.max(1, Math.ceil(seconds)));
    // A provider that sends no header may give the wait in its error body (Apollo's platform-wide 429 does).
    const stated = field(link, "retryAfterSeconds");
    if (typeof stated === "number" && Number.isFinite(stated) && stated >= 0) return Math.min(3_600, Math.max(1, Math.ceil(stated)));
  }
  return DEFAULT_RETRY_SECONDS;
}

/**
 * Billing and quota answers. OpenAI documents these as HTTP 429 and says retrying never restores access:
 * credit_balance_exhausted, organization_spend_limit_exceeded, project_spend_limit_exceeded and
 * organization_usage_limit_exceeded as the error code, insufficient_quota as the error type, and
 * insufficient_quota or billing_hard_limit_reached as the code in older examples. Its pages disagree on whether
 * a name is the code or the type, so both fields are checked.
 */
const OUT_OF_CREDIT = /insufficient_quota|billing_hard_limit|credit_balance|spend_limit|usage_limit_exceeded/i;

function outOfCredit(error: unknown): boolean {
  return chain(error).some((link) => {
    const code = field(link, "code");
    const type = field(link, "type");
    return [code, type].some((value) => typeof value === "string" && OUT_OF_CREDIT.test(value));
  });
}

function timedOut(error: unknown): boolean {
  return chain(error).some((link) => {
    const name = field(link, "name");
    const code = field(link, "code");
    return (typeof name === "string" && TIMEOUT_NAMES.has(name)) || (typeof code === "string" && TIMEOUT_CODES.has(code));
  });
}

export function classifyProviderError(error: unknown): ProviderOutcome | null {
  if (error instanceof ProviderBudgetError) {
    const decision = error.decision;
    switch (decision.status) {
      case "BUDGET_EXCEEDED":
      case "CAP_NOT_CONFIGURED":
        return { code: "BUDGET_EXHAUSTED", retryable: false, reason: error.message, httpStatus: 409 };
      case "RATE_LIMITED":
        return {
          code: "RATE_LIMITED",
          retryable: true,
          retryAfterSeconds: decision.retryAfterSeconds,
          reason: error.message,
          httpStatus: 429,
        };
      case "CAMPAIGN_NOT_ACTIVE":
        return { code: "CAMPAIGN_NOT_ACTIVE", retryable: false, reason: error.message, httpStatus: 409 };
      case "ALREADY_SETTLED":
        return { code: "ALREADY_SETTLED", retryable: false, reason: error.message, httpStatus: 409 };
    }
  }

  const status = providerHttpStatus(error);
  if (status === 402 || ((status === 429 || status === 403) && outOfCredit(error))) {
    return {
      code: "CREDIT_EXHAUSTED",
      retryable: false,
      reason: "The provider reports that its credit or quota is exhausted",
      httpStatus: 402,
    };
  }
  if (status === 429) {
    return {
      code: "RATE_LIMITED",
      retryable: true,
      retryAfterSeconds: retryAfterSeconds(error),
      reason: "The provider rate limit was reached",
      httpStatus: 429,
    };
  }
  if (timedOut(error)) {
    return {
      code: "TIMEOUT",
      retryable: true,
      retryAfterSeconds: DEFAULT_RETRY_SECONDS,
      reason: "The provider did not answer in time",
      httpStatus: 504,
    };
  }
  return null;
}
