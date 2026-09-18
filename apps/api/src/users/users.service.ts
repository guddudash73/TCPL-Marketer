import { Inject, Injectable } from "@nestjs/common";

import { DatabaseService } from "../database/database.service.js";

export interface AuthenticationUser {
  id: string;
  email: string;
  displayName: string | null;
  passwordHash: string;
  status: "ACTIVE" | "DISABLED";
  roles: Array<{ role: { name: string } }>;
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async findForAuthentication(
    email: string,
  ): Promise<AuthenticationUser | null> {
    return await this.database.client.user.findUnique({
      where: { email: normalizeEmail(email) },
      include: { roles: { include: { role: true } } },
    });
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
