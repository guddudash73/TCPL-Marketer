import { createHmac } from "node:crypto";

import {
  N8N_WEBHOOK_TOKEN_TTL_SECONDS,
  createN8nWebhookToken,
} from "@tcpl-marketer/orchestration-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { N8nOrchestrationAdapter } from "../src/orchestration/n8n-orchestration.adapter.js";

const secret = "webhook-signing-key-for-this-test-0123456789";

function decode(token: string) {
  const [header = "", payload = "", signature = ""] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(header, "base64url").toString()) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, number | string>,
    signature,
    unsigned: `${header}.${payload}`,
  };
}

describe("n8n webhook token", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.N8N_BASE_URL;
    delete process.env.N8N_SERVICE_SECRET;
  });

  it("is a valid HS256 JWT that expires in 60 seconds and never contains the key", () => {
    const now = 1_800_000_000_000;
    const token = createN8nWebhookToken(secret, { subject: "campaign-start", now });
    const { header, payload, signature, unsigned } = decode(token);
    expect(header).toEqual({ alg: "HS256", typ: "JWT" });
    expect(payload).toMatchObject({ iss: "tcpl-api", sub: "campaign-start", iat: now / 1_000, exp: now / 1_000 + 60 });
    expect(N8N_WEBHOOK_TOKEN_TTL_SECONDS).toBe(60);
    expect(signature).toBe(createHmac("sha256", secret).update(unsigned).digest("base64url"));
    expect(token).not.toContain(secret);
    expect(Buffer.from(token.replaceAll(".", ""), "base64url").toString("latin1")).not.toContain(secret);
  });

  it("gives every call a different token", () => {
    const now = Date.now();
    expect(createN8nWebhookToken(secret, { subject: "a", now })).not.toBe(createN8nWebhookToken(secret, { subject: "a", now }));
  });

  it("refuses a long lifetime or an empty key", () => {
    for (const ttlSeconds of [0, -1, 1.5, 301]) {
      expect(() => createN8nWebhookToken(secret, { subject: "a", ttlSeconds })).toThrow(/lifetime/);
    }
    expect(() => createN8nWebhookToken("", { subject: "a" })).toThrow(/secret/);
  });

  it("is what the adapter sends, instead of the key", async () => {
    process.env.N8N_BASE_URL = "http://n8n.test";
    process.env.N8N_SERVICE_SECRET = secret;
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ executionId: "1" }));
    vi.stubGlobal("fetch", fetchMock);
    await new N8nOrchestrationAdapter().publish({
      id: "11111111-1111-4111-8111-111111111111",
      eventType: "CAMPAIGN_STARTED",
      aggregateType: "campaign",
      aggregateId: "22222222-2222-4222-8222-222222222222",
      payload: {},
      createdAt: new Date().toISOString(),
    });
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    const token = headers.authorization?.replace("Bearer ", "") ?? "";
    expect(JSON.stringify(headers)).not.toContain(secret);
    expect(decode(token).payload.sub).toBe("campaign-start");
    expect(decode(token).signature).toBe(createHmac("sha256", secret).update(decode(token).unsigned).digest("base64url"));
  });
});
