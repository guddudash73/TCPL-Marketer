import { readFileSync } from "node:fs";
import { Writable } from "node:stream";

import { HttpException, HttpStatus } from "@nestjs/common";
import * as Sentry from "@sentry/node";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpExceptionFilter } from "../src/common/http-exception.filter.js";
import {
  correlationMiddleware,
  currentCorrelationId,
  isValidCorrelationId,
  resolveCorrelationId,
  runWithCorrelation,
} from "../src/common/correlation/correlation-context.js";
import { pinoHttpOptions, redactLogArguments } from "../src/logging/pino-http-options.js";
import {
  initErrorReporting,
  initErrorReportingFromEnvironment,
  isErrorReportingEnabled,
  reportError,
  scrubSentryEvent,
  shutdownErrorReporting,
} from "../src/observability/error-reporting.js";

const SECRET_KEY = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
const BEARER = "Bearer abcdefghijklmnopqrstuvwx";
const SIGNATURE = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";

function captureLines(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, lines: () => chunks.join("").split("\n").filter(Boolean) };
}

describe("correlation IDs", () => {
  it("accepts a well-formed ID and replaces anything that could forge or flood log lines", () => {
    expect(resolveCorrelationId("req_0123456789")).toBe("req_0123456789");
    for (const bad of ["short", "has space in it", "line\nbreak-0123456789", "x".repeat(65), "", undefined, 42]) {
      const issued = resolveCorrelationId(bad);
      expect(isValidCorrelationId(issued)).toBe(true);
      expect(issued).not.toBe(bad);
    }
  });

  it("holds the ID for everything inside the request and echoes it on the response", () => {
    const request = { headers: { "x-correlation-id": "trace-abcdefgh" } } as never;
    const headers: Record<string, string> = {};
    const response = { setHeader: (name: string, value: string) => (headers[name] = value) } as never;
    let seen: string | undefined;
    correlationMiddleware(request, response, () => {
      seen = currentCorrelationId();
    });
    expect(seen).toBe("trace-abcdefgh");
    expect(headers["x-correlation-id"]).toBe("trace-abcdefgh");
    expect(currentCorrelationId()).toBeUndefined();
  });
});

describe("structured logs", () => {
  it("carry the correlation ID and campaign, and never a secret, even when the caller forgot to clean its data", () => {
    const { stream, lines } = captureLines();
    const logger = pino(
      { mixin: pinoHttpOptions.mixin, hooks: pinoHttpOptions.hooks, redact: pinoHttpOptions.redact },
      stream,
    );
    runWithCorrelation("trace-abcdefgh", () => {
      logger.error(
        {
          err: Object.assign(new Error(`Incorrect API key ${SECRET_KEY}`), {
            headers: { authorization: BEARER },
          }),
          providerResponse: { body: `bad key ${SECRET_KEY}`, "x-service-signature": SIGNATURE },
        },
        `request failed with ${BEARER}`,
      );
    }, { campaignId: "5a9e3c3e-0f0a-4ea7-8b9f-1f3d3a2c9b11" });
    const output = lines().join("\n");
    expect(output).toContain("trace-abcdefgh");
    expect(output).toContain("5a9e3c3e-0f0a-4ea7-8b9f-1f3d3a2c9b11");
    for (const secret of [SECRET_KEY, "abcdefghijklmnopqrstuvwx", SIGNATURE]) {
      expect(output).not.toContain(secret);
    }
  });

  it("writes the correlation ID once on a request logger, even when the caller passes it too", () => {
    const { stream, lines } = captureLines();
    const logger = pino(
      {
        mixin: pinoHttpOptions.mixin,
        mixinMergeStrategy: pinoHttpOptions.mixinMergeStrategy,
        hooks: pinoHttpOptions.hooks,
      },
      stream,
    ).child({ correlationId: "trace-abcdefgh" });
    runWithCorrelation("trace-abcdefgh", () => {
      logger.error({ correlationId: "trace-abcdefgh", status: 500 }, "failed");
      logger.info("plain message");
    });
    for (const line of lines()) {
      expect(line.match(/"correlationId"/g)).toHaveLength(1);
    }
    expect(lines()).toHaveLength(2);
  });

  it("leaves serialized request and response objects to pino's own path redaction", () => {
    const request = { method: "GET" };
    const [cleaned] = redactLogArguments([{ req: request, note: `token ${BEARER}` }]) as [Record<string, unknown>];
    expect(cleaned.req).toBe(request);
    expect(String(cleaned.note)).not.toContain("abcdefghijklmnopqrstuvwx");
  });
});

describe("error responses", () => {
  function run(exception: unknown) {
    const logged: unknown[] = [];
    const logger = { error: (...args: unknown[]) => logged.push(args) };
    const filter = new HttpExceptionFilter(logger as never);
    const bodies: unknown[] = [];
    const response = {
      status: () => response,
      json: (body: unknown) => bodies.push(body),
    };
    const host = {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ id: "trace-abcdefgh", method: "POST", url: "/x" }),
      }),
    };
    runWithCorrelation("trace-abcdefgh", () => filter.catch(exception, host as never));
    return { logged: JSON.stringify(logged), body: JSON.stringify(bodies[0]) };
  }

  it("returns a generic message plus the correlation ID for an unexpected error that echoes a secret", () => {
    const { body, logged } = run(
      Object.assign(new Error(`provider failed: ${SECRET_KEY}`), {
        response: { headers: { authorization: BEARER } },
      }),
    );
    expect(body).toContain("An unexpected error occurred");
    expect(body).toContain("trace-abcdefgh");
    expect(body + logged).not.toContain(SECRET_KEY);
    expect(body + logged).not.toContain("abcdefghijklmnopqrstuvwx");
  });

  it("redacts secrets that a deliberate HTTP exception message happens to include", () => {
    const { body } = run(new HttpException(`upstream said ${BEARER}`, HttpStatus.BAD_GATEWAY));
    expect(body).not.toContain("abcdefghijklmnopqrstuvwx");
    expect(body).toContain("upstream said");
  });
});

describe("optional Sentry-compatible error reporting", () => {
  afterEach(async () => {
    await shutdownErrorReporting();
  });

  it("starts with no DSN, makes no network call and does nothing when asked to report", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(initErrorReporting({ dsn: undefined })).toBe(false);
    expect(initErrorReporting({ dsn: "   " })).toBe(false);
    expect(isErrorReportingEnabled()).toBe(false);
    expect(() => reportError(new Error("ignored"))).not.toThrow();
    expect(Sentry.getClient()).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("starts from the environment: no DSN does nothing, a DSN initializes with its environment and release", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(initErrorReportingFromEnvironment({ NODE_ENV: "production" })).toBe(false);
    expect(initErrorReportingFromEnvironment({ SENTRY_DSN: "" })).toBe(false);
    expect(Sentry.getClient()).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    const sent: string[] = [];
    const transport = () => ({
      send: (envelope: unknown) => {
        sent.push(JSON.stringify(envelope));
        return Promise.resolve({ statusCode: 200 });
      },
      flush: () => Promise.resolve(true),
    });
    expect(
      initErrorReportingFromEnvironment(
        { SENTRY_DSN: "https://publickey@o0.ingest.sentry.io/0", NODE_ENV: "staging", SENTRY_RELEASE: "tcpl-test-1" },
        { transport },
      ),
    ).toBe(true);
    expect(Sentry.getClient()?.getOptions()).toMatchObject({ environment: "staging", release: "tcpl-test-1", sendDefaultPii: false });
    reportError(new Error("startup check"));
    await Sentry.flush(1_000);
    expect(sent.join("")).toContain("tcpl-test-1");
  });

  it("is what the real entry point calls", () => {
    const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
    expect(main).toContain("initErrorReportingFromEnvironment()");
    expect(main.indexOf("initErrorReportingFromEnvironment()")).toBeLessThan(main.indexOf("createApp()"));
  });

  it("with a DSN sends only scrubbed events: no request, user, cookies, variables or secrets", async () => {
    const envelopes: unknown[] = [];
    const sent = initErrorReporting({
      dsn: "https://publickey@o0.ingest.sentry.io/0",
      environment: "test",
      transport: () => ({
        send: (envelope) => {
          envelopes.push(envelope);
          return Promise.resolve({ statusCode: 200 });
        },
        flush: () => Promise.resolve(true),
      }),
    });
    expect(sent).toBe(true);
    expect(isErrorReportingEnabled()).toBe(true);

    Sentry.withScope((scope) => {
      scope.setUser({ email: "person@example.com", ip_address: "203.0.113.9" });
      scope.setExtra("providerBody", `key ${SECRET_KEY} ${BEARER}`);
      scope.setContext("request", { headers: { authorization: BEARER }, signature: SIGNATURE });
      scope.setTag("note", `tag ${SECRET_KEY}`);
      reportError(new Error(`Incorrect API key provided: ${SECRET_KEY}`), { correlationId: "trace-abcdefgh" });
    });
    await Sentry.flush(1_000);

    const payload = JSON.stringify(envelopes);
    expect(envelopes.length).toBeGreaterThan(0);
    expect(payload).toContain("trace-abcdefgh");
    for (const secret of [SECRET_KEY, "abcdefghijklmnopqrstuvwx", SIGNATURE, "person@example.com", "203.0.113.9"]) {
      expect(payload).not.toContain(secret);
    }
  });

  it("scrubs request data, personal context, breadcrumbs and stack variables from an event", () => {
    const event = {
      message: `bad ${SECRET_KEY}`,
      request: { url: "https://x/?token=abc", cookies: { a: "b" }, headers: { authorization: BEARER } },
      user: { email: "person@example.com" },
      breadcrumbs: [{ message: BEARER }],
      server_name: "host",
      extra: { body: SECRET_KEY },
      exception: {
        values: [
          { type: "Error", value: `fail ${BEARER}`, stacktrace: { frames: [{ filename: "a.js", vars: { password: "hunter2hunter2" } }] } },
        ],
      },
    } as unknown as Parameters<typeof scrubSentryEvent>[0];
    const scrubbed = JSON.stringify(scrubSentryEvent(event));
    for (const secret of [SECRET_KEY, "abcdefghijklmnopqrstuvwx", "hunter2hunter2", "person@example.com", "token=abc"]) {
      expect(scrubbed).not.toContain(secret);
    }
    expect(scrubbed).toContain("a.js");
  });
});
