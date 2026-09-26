import { createHmac, timingSafeEqual } from "node:crypto";

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";

interface ServiceRequest {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  originalUrl: string;
}

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

@Injectable()
export class ServiceAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const secret = process.env.N8N_SERVICE_SECRET;
    if (!secret) {
      throw new ServiceUnavailableException(
        "Service authentication is not configured",
      );
    }

    const request = context.switchToHttp().getRequest<ServiceRequest>();
    const timestamp = firstHeader(request.headers["x-service-timestamp"]);
    const provided = firstHeader(request.headers["x-service-signature"]);
    const timestampMs = Number(timestamp);

    if (
      !timestamp ||
      !provided ||
      !Number.isFinite(timestampMs) ||
      Math.abs(Date.now() - timestampMs) > MAX_CLOCK_SKEW_MS
    ) {
      throw new UnauthorizedException("Invalid service signature");
    }

    const message = `${timestamp}\n${request.method.toUpperCase()}\n${request.originalUrl}`;
    const expected = createHmac("sha256", secret).update(message).digest();
    const signature = Buffer.from(provided, "hex");
    if (
      signature.length !== expected.length ||
      !timingSafeEqual(signature, expected)
    ) {
      throw new UnauthorizedException("Invalid service signature");
    }

    return true;
  }
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
