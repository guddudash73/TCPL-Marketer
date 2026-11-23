import type { IncomingMessage, ServerResponse } from "node:http";
import type { Options } from "pino-http";

import {
  CORRELATION_HEADER,
  currentCorrelation,
  resolveCorrelationId,
} from "../common/correlation/correlation-context.js";
import { redact, redactString } from "../common/redaction/redactor.js";

/** Keys that pino serializes itself (with the path redaction below) and must not be walked here. */
const SERIALIZED_BY_PINO = new Set(["req", "res"]);

/**
 * Applies the shared redactor to everything handed to the logger, so a log line
 * cannot carry a secret even when a caller forgets to clean its data first.
 */
export function redactLogArguments(args: readonly unknown[]): unknown[] {
  return args.map((argument, index) => {
    if (typeof argument === "string") return redactString(argument);
    if (argument instanceof Error) return { err: redact(argument) };
    if (index === 0 && typeof argument === "object" && argument !== null) {
      const cleaned: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(argument)) {
        cleaned[key] = SERIALIZED_BY_PINO.has(key)
          ? value
          : (redact({ [key]: value }) as Record<string, unknown>)[key];
      }
      return cleaned;
    }
    return argument;
  });
}

export const pinoHttpOptions: Options = {
  genReqId(request: IncomingMessage, response: ServerResponse): string {
    // The correlation middleware has normally validated the header already.
    const correlationId = resolveCorrelationId(request.headers[CORRELATION_HEADER]);
    response.setHeader(CORRELATION_HEADER, correlationId);
    return correlationId;
  },
  customProps(request: IncomingMessage): Record<string, string> {
    return { correlationId: String(request.id) };
  },
  mixin(_mergeObject, _level, logger): Record<string, string> {
    const trace = currentCorrelation();
    if (!trace) return {};
    return {
      // A request logger already has the ID as a binding; writing it again would duplicate the key.
      ...(logger.bindings().correlationId ? {} : { correlationId: trace.correlationId }),
      ...(trace.campaignId ? { campaignId: trace.campaignId } : {}),
      ...(trace.stageRunId ? { stageRunId: trace.stageRunId } : {}),
    };
  },
  // Merge the trace fields into the log object so a key is never written twice.
  mixinMergeStrategy: (mergeObject, mixinObject) => ({ ...mixinObject, ...mergeObject }),
  hooks: {
    logMethod(args, method) {
      const cleaned = redactLogArguments(args);
      const first = cleaned[0];
      if (typeof first === "object" && first !== null && this.bindings().correlationId) {
        delete (first as Record<string, unknown>).correlationId;
      }
      return method.apply(this, cleaned as Parameters<typeof method>);
    },
  },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers.x-api-key",
      'req.headers["x-service-signature"]',
      'req.headers["x-service-timestamp"]',
      'res.headers["set-cookie"]',
      "req.body.password",
      "req.body.refreshToken",
      "req.body.accessToken",
    ],
    censor: "[REDACTED]",
  },
};
