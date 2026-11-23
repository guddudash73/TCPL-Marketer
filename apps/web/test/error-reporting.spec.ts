import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { buildSentryOptions, scrubSentryEvent, scrubText } from "../lib/error-reporting";

const KEY = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const BEARER = "Bearer abcdefghijklmnopqrstuvwx";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r";

describe("web error reporting", () => {
  it("builds no options, and so initializes nothing, without a DSN", () => {
    expect(buildSentryOptions({})).toBeNull();
    expect(buildSentryOptions({ dsn: "" })).toBeNull();
    expect(buildSentryOptions({ dsn: "   " })).toBeNull();
  });

  it("builds privacy-first options when a DSN is set", () => {
    const options = buildSentryOptions({
      dsn: " https://publickey@o0.ingest.sentry.io/0 ",
      environment: "staging",
      release: "web-1",
    });
    expect(options).toMatchObject({
      dsn: "https://publickey@o0.ingest.sentry.io/0",
      environment: "staging",
      release: "web-1",
      sendDefaultPii: false,
      maxBreadcrumbs: 0,
      tracesSampleRate: 0,
    });
    expect(options?.beforeSend).toBe(scrubSentryEvent);
  });

  it("scrubs credentials from text without touching ordinary words", () => {
    const text = scrubText(`failed ${BEARER} key ${KEY} ${JWT} password=hunter2hunter2 https://u:p4ssw0rd@db.example/x page 2`);
    for (const secret of ["abcdefghijklmnopqrstuvwx", KEY, JWT, "hunter2hunter2", "p4ssw0rd"]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("page 2");
    expect(scrubText("x".repeat(5_000)).length).toBeLessThan(2_100);
  });

  it("removes request data, users, breadcrumbs and stack variables, and scrubs what is left", () => {
    const event = {
      message: `bad ${KEY}`,
      request: { url: "https://x/?token=abc", cookies: { a: "b" }, headers: { authorization: BEARER } },
      user: { email: "person@example.com", ip_address: "203.0.113.9" },
      breadcrumbs: [{ message: BEARER }],
      server_name: "host",
      extra: { authorization: BEARER, note: `see ${KEY}`, isActive: true },
      tags: { correlationId: "trace-abcdefgh" },
      exception: {
        values: [
          { value: `fail ${BEARER}`, stacktrace: { frames: [{ filename: "a.js", vars: { password: "hunter2hunter2" } }] } },
        ],
      },
    };
    const scrubbed = JSON.stringify(scrubSentryEvent(event));
    for (const secret of [KEY, "abcdefghijklmnopqrstuvwx", "hunter2hunter2", "person@example.com", "203.0.113.9", "token=abc"]) {
      expect(scrubbed).not.toContain(secret);
    }
    for (const kept of ["a.js", "trace-abcdefgh", "isActive"]) expect(scrubbed).toContain(kept);
  });

  it("is wired into the real Next.js entry points, only through the scrubbing options", () => {
    const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    const server = read("instrumentation.ts");
    const client = read("instrumentation-client.ts");
    for (const source of [server, client]) {
      expect(source).toContain("buildSentryOptions(");
      expect(source).toContain("if (options) Sentry.init(options)");
      expect(source).toContain("process.env.NEXT_PUBLIC_SENTRY_DSN");
    }
    expect(server).toContain("export function register()");
    expect(server).toContain("export const onRequestError = Sentry.captureRequestError");
    expect(client).toContain("onRouterTransitionStart");
    expect(read("app/global-error.tsx")).toContain("Sentry.captureException(error)");
  });
});
