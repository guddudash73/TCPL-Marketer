import { describe, expect, it } from "vitest";

import {
  CIRCULAR,
  REDACTED,
  configuredSecretValues,
  isSecretKey,
  redact,
  redactString,
} from "../src/common/redaction/redactor.js";

const OPENAI_KEY = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const HMAC = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";

function serialized(value: unknown): string {
  return JSON.stringify(redact(value));
}

describe("redaction", () => {
  it("masks secret keys at any depth, including arrays", () => {
    const output = serialized({
      authorization: "Bearer abcdefghijklmnop",
      nested: { deeper: [{ apiKey: OPENAI_KEY, safe: "visible" }] },
      "x-service-signature": HMAC,
      refreshToken: "refresh-value-123",
      password: "correct horse battery staple",
      cookie: "session=abc123",
    });
    for (const secret of [OPENAI_KEY, HMAC, "refresh-value-123", "correct horse", "abc123", "abcdefghijklmnop"]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("visible");
  });

  it("removes secret-shaped values from free text under harmless keys", () => {
    const text = [
      `provider said: invalid key ${OPENAI_KEY}`,
      `Authorization: Bearer abcdefghijklmnopqrstuvwx`,
      `the header value was Bearer zyxwvutsrqponmlkjihgfedcba`,
      `jwt ${JWT}`,
      `https://user:hunter2secret@db.internal/path?api_key=querysecret1&x=1`,
      `signature=${HMAC}`,
      "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBg\n-----END PRIVATE KEY-----",
    ].join("\n");
    const output = redactString(text);
    for (const secret of [OPENAI_KEY, "abcdefghijklmnopqrstuvwx", "zyxwvutsrqponmlkjihgfedcba", JWT, "hunter2secret", "querysecret1", HMAC, "MIIBVQIBADANBg"]) {
      expect(output).not.toContain(secret);
    }
    expect(output).toContain("x=1");
  });

  it("masks nested provider error bodies, causes and headers on Error objects", () => {
    const providerError = Object.assign(new Error(`401 for key ${OPENAI_KEY}`), {
      status: 401,
      headers: { authorization: `Bearer ${OPENAI_KEY}`, "x-request-id": "req_123" },
      error: { message: `Incorrect API key provided: ${OPENAI_KEY}`, code: "invalid_api_key" },
    });
    const wrapper = new Error("search failed", { cause: providerError });
    const output = serialized({ err: wrapper });
    expect(output).not.toContain(OPENAI_KEY);
    expect(output).toContain("req_123");
    expect(output).toContain("search failed");
  });

  it("removes exact configured secrets wherever they appear, even in odd text", () => {
    const secret = "plain-service-secret-value-1";
    const output = redactString(`prefix${secret}suffix and ${secret}`, { secretValues: [secret] });
    expect(output).not.toContain(secret);
    expect(output).toContain("prefix");
  });

  it("learns secrets from secret-looking environment variables and connection-string passwords", () => {
    const values = configuredSecretValues({
      N8N_SERVICE_SECRET: "env-service-secret-123",
      DATABASE_URL: "postgresql://app:dbPassw0rd!@localhost:5432/db",
      APP_NAME: "visible-name",
      SHORT_TOKEN: "abc",
    });
    expect(values).toContain("env-service-secret-123");
    expect(values).toContain("dbPassw0rd!");
    expect(values).not.toContain("visible-name");
    expect(values).not.toContain("abc");
  });

  it("does not mangle ordinary identifiers, hashes, counters or booleans", () => {
    const sample = {
      campaignId: "5a9e3c3e-0f0a-4ea7-8b9f-1f3d3a2c9b11",
      inputHash: HMAC,
      author: "Ada",
      usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      hasPassword: true,
      correlationId: "req_abcdef",
      url: "https://example.com/services?page=2",
    };
    expect(redact(sample)).toEqual({ ...sample, hasPassword: true });
  });

  it("handles circular structures, depth, size and exotic values without throwing", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    expect(redact(loop)).toEqual({ name: "loop", self: CIRCULAR });

    let deep: Record<string, unknown> = { leaf: OPENAI_KEY };
    for (let level = 0; level < 20; level += 1) deep = { level: deep };
    expect(JSON.stringify(redact(deep))).not.toContain(OPENAI_KEY);

    const wide = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`k${index}`, index]));
    expect(Object.keys(redact(wide) as object).length).toBeLessThanOrEqual(101);

    expect(redactString("x".repeat(50_000)).length).toBeLessThan(2_100);
    expect(() => redact({ big: 10n, fn: () => 1, date: new Date(0), buffer: Buffer.from("secret") })).not.toThrow();
    expect(redact(new Map([["password", "pw-value-1"]]))).toEqual({ password: REDACTED });
  });

  it("is pure: the input is not changed and the result is JSON safe", () => {
    const input = { token: "tok-value-123", nested: { list: [1, 2] } };
    const copy = structuredClone(input);
    const output = redact(input);
    expect(input).toEqual(copy);
    expect(() => JSON.stringify(output)).not.toThrow();
  });

  it("classifies key names", () => {
    for (const key of ["password", "accessToken", "x-api-key", "Set-Cookie", "clientSecret", "x-service-signature", "Authorization", "privateKey"]) {
      expect(isSecretKey(key), key).toBe(true);
    }
    for (const key of ["author", "campaignId", "inputHash", "name", "status"]) {
      expect(isSecretKey(key), key).toBe(false);
    }
  });
});
