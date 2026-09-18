import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { AuthService } from "./auth.service.js";
import type { AuthenticatedRequest } from "./auth.types.js";
import { PUBLIC_ROUTE_KEY } from "./public.decorator.js";

export const SESSION_COOKIE_NAME = "tcpl_session";

@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      PUBLIC_ROUTE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractSessionToken(request.headers);
    if (!token) {
      throw new UnauthorizedException("Authentication required");
    }

    request.user = await this.auth.authenticateSession(token);
    request.authToken = token;
    return true;
  }
}

function extractSessionToken(
  headers: AuthenticatedRequest["headers"],
): string | undefined {
  const authorization = firstHeader(headers.authorization);
  if (authorization) {
    const [scheme, token] = authorization.split(" ");
    if (scheme?.toLowerCase() === "bearer" && token) {
      return token;
    }
  }

  const cookieHeader = firstHeader(headers.cookie);
  if (!cookieHeader) {
    return undefined;
  }
  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator === -1) {
      continue;
    }
    const name = cookie.slice(0, separator).trim();
    if (name === SESSION_COOKIE_NAME) {
      try {
        return decodeURIComponent(cookie.slice(separator + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
