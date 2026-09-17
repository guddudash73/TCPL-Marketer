import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Logger } from 'nestjs-pino';

interface RequestWithId {
  id?: string;
  method: string;
  url: string;
}

interface JsonResponse {
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
    const isHttpException = exception instanceof HttpException;
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const exceptionResponse = isHttpException ? exception.getResponse() : undefined;
    const message = getMessage(exceptionResponse, isHttpException);

    this.logger.error(
      {
        err: exception,
        correlationId: request.id,
        method: request.method,
        path: request.url,
        status,
      },
      'Request failed',
    );

    response.status(status).json({
      statusCode: status,
      error: isHttpException ? 'HTTP_ERROR' : 'INTERNAL_SERVER_ERROR',
      message,
      correlationId: request.id,
    });
  }
}

function getMessage(response: string | object | undefined, isHttpException: boolean): string | string[] {
  if (typeof response === 'string') {
    return response;
  }

  if (response && 'message' in response) {
    const message = response.message;
    if (typeof message === 'string' || Array.isArray(message)) {
      return message;
    }
  }

  return isHttpException ? 'Request failed' : 'An unexpected error occurred';
}
