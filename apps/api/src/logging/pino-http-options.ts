import { randomUUID } from "node:crypto";

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Options } from "pino-http";

export const pinoHttpOptions: Options = {
  genReqId(request: IncomingMessage, response: ServerResponse): string {
    const incomingCorrelationId = request.headers["x-correlation-id"];
    const correlationId =
      typeof incomingCorrelationId === "string" &&
      incomingCorrelationId.length > 0
        ? incomingCorrelationId
        : randomUUID();

    response.setHeader("x-correlation-id", correlationId);
    return correlationId;
  },
  customProps(request: IncomingMessage): Record<string, string> {
    return { correlationId: String(request.id) };
  },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers.x-api-key",
      "req.body.password",
      "req.body.refreshToken",
      "req.body.accessToken",
    ],
    censor: "[REDACTED]",
  },
};
