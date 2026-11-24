import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Logger } from "nestjs-pino";

import { classifyProviderError } from "../provider-budget/provider-outcome.js";
import { reportError } from "../observability/error-reporting.js";
import { currentCorrelationId } from "./correlation/correlation-context.js";
import { redact, redactString } from "./redaction/redactor.js";

interface RequestWithId {
  id?: string;
  method: string;
  url: string;
}

interface JsonResponse {
  setHeader(name: string, value: string): void;
  status(statusCode: number): JsonResponse;
  json(body: object): void;
}

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<JsonResponse>();
    const request = context.getRequest<RequestWithId>();

    // Spend, rate, credit and timeout outcomes get a deliberate answer: a stable code, the
    // right status and, when a retry can succeed, a Retry-After header. The reason is generic.
    const outcome = classifyProviderError(exception);
    if (outcome) {
      const outcomeCorrelationId = currentCorrelationId() ?? request.id;
      this.logger.warn(
        { outcome: outcome.code, correlationId: outcomeCorrelationId, method: request.method, path: request.url, status: outcome.httpStatus },
        "Provider outcome returned to caller",
      );
      if (outcome.retryAfterSeconds !== undefined) response.setHeader("Retry-After", String(outcome.retryAfterSeconds));
      response.status(outcome.httpStatus).json({
        statusCode: outcome.httpStatus,
        error: outcome.code,
        message: sanitizeMessage(outcome.reason),
        retryable: outcome.retryable,
        ...(outcome.retryAfterSeconds !== undefined ? { retryAfterSeconds: outcome.retryAfterSeconds } : {}),
        correlationId: outcomeCorrelationId,
      });
      return;
    }

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse = isHttpException
      ? exception.getResponse()
      : undefined;
    const correlationId = currentCorrelationId() ?? request.id;
    const message = sanitizeMessage(getMessage(exceptionResponse, isHttpException));

    this.logger.error(
      {
        err: redact(exception),
        correlationId,
        method: request.method,
        path: request.url,
        status,
      },
      "Request failed",
    );

    if (status >= 500) reportError(exception, { correlationId });

    response.status(status).json({
      statusCode: status,
      error: isHttpException ? "HTTP_ERROR" : "INTERNAL_SERVER_ERROR",
      message,
      correlationId,
    });
  }
}

function getMessage(
  response: string | object | undefined,
  isHttpException: boolean,
): string | string[] {
  if (typeof response === "string") {
    return response;
  }

  if (response && "message" in response) {
    const message = response.message;
    if (typeof message === "string" || Array.isArray(message)) {
      return message;
    }
  }

  return isHttpException ? "Request failed" : "An unexpected error occurred";
}

/** Client-facing messages may echo provider text, so they pass through the redactor too. */
function sanitizeMessage(message: string | string[]): string | string[] {
  return Array.isArray(message)
    ? message.map((item) => (typeof item === "string" ? redactString(item) : item))
    : redactString(message);
}
