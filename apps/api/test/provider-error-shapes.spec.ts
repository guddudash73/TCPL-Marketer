import OpenAI from "openai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ApolloPeopleSearchAdapter } from "../src/people/apollo-people-search.adapter.js";
import { classifyProviderError } from "../src/provider-budget/provider-outcome.js";
import { testCall } from "./support/provider-call.js";

/**
 * The outcome mapper against the real shapes of the providers' answers (PH1-03 follow-up).
 * OpenAI cases are built with the installed SDK's own error classes from the codes in OpenAI's
 * error-codes and rate-limits documentation; Apollo cases use the bodies and headers observed from
 * the live API on 2026-11-24 and the shapes Apollo documents.
 */
const openAiError = (status: number, error: Record<string, unknown>, headers: Record<string, string> = {}) =>
  OpenAI.APIError.generate(status, { error }, undefined, new Headers(headers));

describe("OpenAI answers", () => {
  it("builds the SDK error the way the mapper reads it", () => {
    const error = openAiError(429, { message: "You exceeded your current quota", type: "insufficient_quota", code: "insufficient_quota" });
    expect(error).toBeInstanceOf(OpenAI.RateLimitError);
    expect(error).toMatchObject({ status: 429, code: "insufficient_quota", type: "insufficient_quota" });
  });

  it.each([
    ["credit_balance_exhausted", { code: "credit_balance_exhausted" }],
    ["organization_spend_limit_exceeded", { code: "organization_spend_limit_exceeded" }],
    ["project_spend_limit_exceeded", { code: "project_spend_limit_exceeded" }],
    ["organization_usage_limit_exceeded", { code: "organization_usage_limit_exceeded" }],
    ["insufficient_quota as the type", { type: "insufficient_quota", code: "billing_error" }],
    ["insufficient_quota as the code", { type: "billing", code: "insufficient_quota" }],
    ["billing_hard_limit_reached", { code: "billing_hard_limit_reached" }],
  ])("treats a 429 for %s as exhausted credit that retrying cannot fix", (_label, body) => {
    const outcome = classifyProviderError(openAiError(429, { message: "billing", ...body }, { "retry-after": "30" }));
    expect(outcome).toMatchObject({ code: "CREDIT_EXHAUSTED", retryable: false, httpStatus: 402 });
    // Even with a Retry-After header, which OpenAI says does not mean a billing error can be retried away.
    expect(outcome?.retryAfterSeconds).toBeUndefined();
  });

  it("treats a temporary rate limit as retryable and follows Retry-After", () => {
    const slow = classifyProviderError(openAiError(429, { message: "Slow down", type: "rate_limit_error", code: "slow_down" }, { "retry-after": "7" }));
    expect(slow).toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfterSeconds: 7, httpStatus: 429 });
    const plain = classifyProviderError(openAiError(429, { message: "Rate limit reached for requests" }));
    expect(plain).toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfterSeconds: 30 });
  });

  it("leaves authentication, unknown-model and overload answers to their existing handling", () => {
    expect(classifyProviderError(openAiError(401, { code: "invalid_api_key", type: "invalid_request_error", message: "bad key" }))).toBeNull();
    expect(classifyProviderError(openAiError(404, { code: "model_not_found", type: "invalid_request_error", message: "no model" }))).toBeNull();
    expect(classifyProviderError(openAiError(503, { message: "overloaded" }, { "retry-after": "5" }))).toBeNull();
    expect(classifyProviderError(openAiError(403, { code: "unsupported_country_region_territory", message: "region" }))).toBeNull();
  });

  it("does not confuse a request-rate code that merely contains a similar word with a billing code", () => {
    expect(classifyProviderError(openAiError(429, { code: "rate_limit_exceeded", type: "invalid_request_error", message: "video rate" }))).toMatchObject({ code: "RATE_LIMITED" });
  });
});

describe("Apollo answers", () => {
  let savedKey: string | undefined;
  beforeAll(() => {
    savedKey = process.env.APOLLO_API_KEY;
    process.env.APOLLO_API_KEY = "apollo-shape-test-key";
  });
  afterAll(() => {
    if (savedKey === undefined) delete process.env.APOLLO_API_KEY;
    else process.env.APOLLO_API_KEY = savedKey;
  });

  const input = {
    organization: { id: crypto.randomUUID(), name: "apollo.io", domain: "apollo.io", location: null },
    roles: [{ decisionMakerProfileId: crypto.randomUUID(), title: "Chief Executive Officer", priority: 1, seniorities: ["c_suite"], positiveTerms: [], negativeTerms: [] }],
    maximumResults: 1,
  };
  const failure = async (status: number, body: unknown, headers: Record<string, string> = {}) => {
    const fetchStub = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers }));
    const error = await new ApolloPeopleSearchAdapter(fetchStub as unknown as typeof fetch).searchPeople(input, testCall("apollo", "people-search")).catch((e: unknown) => e);
    return { error, cause: (error as { cause?: Record<string, unknown> }).cause };
  };

  it("keeps the code of a long real 401 body for an invalid key, and does not treat it as an exhaustion outcome", async () => {
    // The real answer to an invalid key, observed live: its body is longer than the 300 characters that go into a message.
    const real = {
      error: "Invalid API key. See https://docs.apollo.io/reference/authentication for how to authenticate.",
      error_details: {
        code: "AUTH.AUTHENTICATION.API_KEY_INVALID",
        message: "This API key is not valid.",
        suggestions: [
          { label: "Send a valid API key in the X-Api-Key header", header: "X-Api-Key" },
          { label: "Check how to create and send an Apollo API key", url: "https://docs.apollo.io/reference/authentication" },
        ],
      },
    };
    expect(JSON.stringify(real).length).toBeGreaterThan(300);
    const { error, cause } = await failure(401, real);
    expect(cause).toMatchObject({ status: 401, code: "AUTH.AUTHENTICATION.API_KEY_INVALID" });
    expect(classifyProviderError(error)).toBeNull();
  });

  it("leaves a 422 and a documented 403 plan error to their existing handling", async () => {
    const parameters = await failure(422, { error: "Parameters misconfigured. page must be an positive integer. You are passing -1" });
    expect(classifyProviderError(parameters.error)).toBeNull();
    const plan = await failure(403, { error: "API access is not available on this plan", error_code: "API_INACCESSIBLE", error_details: { code: "AUTH.AUTHORIZATION.API_INACCESSIBLE" } });
    expect(plan.cause).toMatchObject({ status: 403, code: "AUTH.AUTHORIZATION.API_INACCESSIBLE" });
    expect(classifyProviderError(plan.error)).toBeNull();
  });

  it("follows Retry-After for a plan rate limit", async () => {
    const { error } = await failure(429, { error_details: { code: "USAGE.RATE_LIMIT.API_RATE_LIMIT_EXCEEDED", context: { window: { value: "minute" } } } }, { "retry-after": "42" });
    expect(classifyProviderError(error)).toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfterSeconds: 42 });
  });

  it("uses the wait Apollo states in the body when its platform-wide 429 sends no header", async () => {
    const { error, cause } = await failure(429, {
      error_details: { code: "USAGE.RATE_LIMIT.PLATFORM_RATE_LIMIT", suggestions: [{ label: "Wait and retry", retry_after_seconds: 60 }] },
    });
    expect(cause).toMatchObject({ code: "USAGE.RATE_LIMIT.PLATFORM_RATE_LIMIT", retryAfterSeconds: 60 });
    expect(classifyProviderError(error)).toMatchObject({ code: "RATE_LIMITED", retryable: true, retryAfterSeconds: 60 });
  });

  it("falls back to the default wait when neither a header nor a stated wait exists", async () => {
    const { error } = await failure(429, { error_details: { code: "USAGE.RATE_LIMIT.PLATFORM_RATE_LIMIT" } });
    expect(classifyProviderError(error)).toMatchObject({ code: "RATE_LIMITED", retryAfterSeconds: 30 });
  });
});
