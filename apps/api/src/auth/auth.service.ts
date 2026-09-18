import { createHash, randomBytes } from "node:crypto";

import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";

import { AuditService } from "../audit/audit.service.js";
import { DatabaseService } from "../database/database.service.js";
import { normalizeEmail, UsersService } from "../users/users.service.js";
import type { AuthPrincipal } from "./auth.types.js";
import { PasswordHasher } from "./password-hasher.js";

const DUMMY_PASSWORD_HASH =
  "scrypt$16384$8$1$AAECAwQFBgcICQoLDA0ODw$3bO62kUIxQGbnkGkrj0uhBQzanvpywJHQxHvEs7Y4ECb83RiooqgN0ekVjZisgUHlyt6pBpHaZo_5oT9xbSM8A";

interface RequestContext {
  ipAddress?: string;
  userAgent?: string;
}

interface LoginResult {
  token: string;
  expiresAt: Date;
  user: AuthPrincipal;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PasswordHasher) private readonly passwordHasher: PasswordHasher,
    @Inject(UsersService) private readonly users: UsersService,
  ) {}

  async login(
    email: string,
    password: string,
    context: RequestContext,
  ): Promise<LoginResult> {
    const normalizedEmail = normalizeEmail(email);
    const user = await this.users.findForAuthentication(normalizedEmail);
    const passwordMatches = await this.passwordHasher.verify(
      password,
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
    );

    if (!user || !passwordMatches || user.status !== "ACTIVE") {
      await this.audit.record({
        action: "auth.login.failed",
        resourceType: "user",
        resourceId: normalizedEmail,
        metadata: requestMetadata(context),
      });
      throw new UnauthorizedException("Invalid email or password");
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + sessionTtlMilliseconds());
    await this.database.client.$transaction([
      this.database.client.userSession.create({
        data: { userId: user.id, tokenHash: hashToken(token), expiresAt },
      }),
      this.database.client.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      }),
    ]);
    await this.audit.record({
      action: "auth.login.succeeded",
      actorUserId: user.id,
      resourceType: "user",
      resourceId: user.id,
      metadata: requestMetadata(context),
    });

    return { token, expiresAt, user: toPrincipal(user) };
  }

  async authenticateSession(token: string): Promise<AuthPrincipal> {
    const session = await this.database.client.userSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: { include: { roles: { include: { role: true } } } } },
    });
    if (
      !session ||
      session.revokedAt !== null ||
      session.expiresAt.getTime() <= Date.now() ||
      session.user.status !== "ACTIVE"
    ) {
      throw new UnauthorizedException("Session is invalid or expired");
    }
    return toPrincipal(session.user);
  }

  async logout(
    token: string,
    principal: AuthPrincipal,
    context: RequestContext,
  ): Promise<void> {
    await this.database.client.userSession.updateMany({
      where: { tokenHash: hashToken(token), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await this.audit.record({
      action: "auth.logout",
      actorUserId: principal.id,
      resourceType: "user",
      resourceId: principal.id,
      metadata: requestMetadata(context),
    });
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sessionTtlMilliseconds(): number {
  const hours = Number(process.env.AUTH_SESSION_TTL_HOURS ?? "8");
  if (!Number.isFinite(hours) || hours <= 0 || hours > 168) {
    throw new Error("AUTH_SESSION_TTL_HOURS must be between 1 and 168");
  }
  return hours * 60 * 60 * 1000;
}

function requestMetadata(
  context: RequestContext,
): Record<string, string> | undefined {
  const metadata = Object.fromEntries(
    Object.entries({
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    }).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].length > 0,
    ),
  );
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function toPrincipal(user: {
  id: string;
  email: string;
  displayName: string | null;
  roles: Array<{ role: { name: string } }>;
}): AuthPrincipal {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    roles: user.roles.map(({ role }) => role.name),
  };
}
