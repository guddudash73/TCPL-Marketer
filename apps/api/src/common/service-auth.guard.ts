import { randomBytes, timingSafeEqual } from "node:crypto";

import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  EMPTY_BODY_SHA256,
  SERVICE_AUTH_HEADERS,
  SERVICE_BOUND_HEADERS,
  computeServiceSignature,
  isServiceCallerId,
  isValidServiceRequestId,
  sha256Hex,
  type ServiceCanonicalInput,
  type ServiceScope,
} from "@tcpl-marketer/orchestration-contracts";

import {
  ServiceAuthRejectionsService,
  type ServiceAuthRejectionReason,
} from "./service-auth/service-auth-rejections.service.js";
import {
  anyServiceCallerConfigured,
  readMaxSkewSeconds,
  resolveServiceCaller,
} from "./service-auth/service-auth.config.js";
import { ServiceReplayStore } from "./service-auth/service-replay.store.js";
import { SERVICE_SCOPE_KEY } from "./service-auth/service-scope.decorator.js";

interface ServiceRequest {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  originalUrl: string;
  rawBody?: Buffer;
}

const TIMESTAMP = /^\d{13}$/;
const SIGNATURE = /^[0-9a-f]{64}$/;
/** Compared against when the caller is unknown, so that path costs the same as a wrong secret. */
const DECOY_SECRET = randomBytes(32).toString("hex");

/**
 * Authenticates machine callers (n8n and internal tooling). Checks run from
 * cheapest to most expensive, and a request ID is only stored after the
 * signature and scope pass, so unauthenticated traffic cannot fill the table.
 * Every authentication failure gets the same response; the reason is audited.
 */
@Injectable()
export class ServiceAuthGuard implements CanActivate {
  private readonly logger = new Logger(ServiceAuthGuard.name);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ServiceReplayStore) private readonly replay: ServiceReplayStore,
    @Inject(ServiceAuthRejectionsService)
    private readonly rejections: ServiceAuthRejectionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!anyServiceCallerConfigured()) {
      throw new ServiceUnavailableException("Service authentication is not configured");
    }
    const request = context.switchToHttp().getRequest<ServiceRequest>();
    const scope = this.reflector.getAllAndOverride<ServiceScope | undefined>(SERVICE_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const reject = async (
      reason: ServiceAuthRejectionReason,
      caller = "unknown",
    ): Promise<never> => {
      await this.rejections.record({
        reason,
        caller,
        scope: scope ?? null,
        method: request.method,
        url: request.originalUrl,
      });
      if (reason === "WRONG_SCOPE" || reason === "NO_ROUTE_SCOPE") {
        throw new ForbiddenException("Service caller is not allowed to use this endpoint");
      }
      if (reason === "REPLAY_STORE_UNAVAILABLE") {
        throw new ServiceUnavailableException("Service authentication is unavailable");
      }
      throw new UnauthorizedException("Invalid service signature");
    };

    // A route with no declared scope is closed to every caller.
    if (!scope) return reject("NO_ROUTE_SCOPE");

    const keyId = firstHeader(request.headers[SERVICE_AUTH_HEADERS.keyId]);
    const timestamp = firstHeader(request.headers[SERVICE_AUTH_HEADERS.timestamp]);
    const requestId = firstHeader(request.headers[SERVICE_AUTH_HEADERS.requestId]);
    const provided = firstHeader(request.headers[SERVICE_AUTH_HEADERS.signature]);
    if (!keyId || !timestamp || !requestId || !provided) return reject("MISSING_HEADERS");
    if (
      !TIMESTAMP.test(timestamp) ||
      !SIGNATURE.test(provided) ||
      !isValidServiceRequestId(requestId)
    ) {
      return reject("MALFORMED_HEADERS");
    }

    const knownCaller = isServiceCallerId(keyId);
    const callerLabel = knownCaller ? keyId : "unknown";
    const maxSkewMs = readMaxSkewSeconds() * 1_000;
    const age = Date.now() - Number(timestamp);
    if (age > maxSkewMs) return reject("EXPIRED_TIMESTAMP", callerLabel);
    if (age < -maxSkewMs) return reject("FUTURE_TIMESTAMP", callerLabel);

    const bodySha256 = hashVerifiableBody(request);
    if (!bodySha256) return reject("UNVERIFIABLE_BODY", callerLabel);

    const canonical: ServiceCanonicalInput = {
      keyId,
      timestamp,
      requestId,
      method: request.method,
      path: request.originalUrl,
      bodySha256,
      diagnosticRunId: firstHeader(request.headers[SERVICE_BOUND_HEADERS.diagnosticRunId]),
      inputHash: firstHeader(request.headers[SERVICE_BOUND_HEADERS.inputHash]),
    };

    if (!knownCaller) {
      matchesAny([DECOY_SECRET], canonical, provided);
      return reject("UNKNOWN_CALLER");
    }
    const caller = resolveServiceCaller(keyId);
    if (caller.secrets.length === 0) {
      throw new ServiceUnavailableException("Service authentication is not configured");
    }
    const matched = matchesAny(caller.secrets, canonical, provided);
    if (matched < 0) return reject("BAD_SIGNATURE", caller.id);
    if (matched > 0) {
      this.logger.warn({ msg: "Service caller used its rotating-out secret", caller: caller.id });
    }
    if (!caller.scopes.includes(scope)) return reject("WRONG_SCOPE", caller.id);

    let firstUse: boolean;
    try {
      firstUse = await this.replay.consume(caller.id, requestId);
    } catch {
      return reject("REPLAY_STORE_UNAVAILABLE", caller.id);
    }
    if (!firstUse) return reject("REPLAYED", caller.id);
    return true;
  }
}

/** Index of the matching secret, or -1. Every secret is always checked. */
function matchesAny(
  secrets: readonly string[],
  canonical: ServiceCanonicalInput,
  provided: string,
): number {
  const signature = Buffer.from(provided, "hex");
  let matched = -1;
  secrets.forEach((secret, index) => {
    const expected = Buffer.from(computeServiceSignature(secret, canonical), "hex");
    if (timingSafeEqual(signature, expected) && matched < 0) matched = index;
  });
  return matched;
}

/**
 * Hash of the body exactly as received, or null when a body arrived that the
 * parsers did not capture (unsupported type or compressed), since it cannot be verified.
 */
function hashVerifiableBody(request: ServiceRequest): string | null {
  const encoding = firstHeader(request.headers["content-encoding"]);
  if (encoding && encoding.toLowerCase() !== "identity") return null;
  if (request.rawBody) return sha256Hex(request.rawBody);
  const length = firstHeader(request.headers["content-length"]);
  const hasBody =
    Boolean(request.headers["transfer-encoding"]) || (length !== undefined && length !== "0");
  return hasBody ? null : EMPTY_BODY_SHA256;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
