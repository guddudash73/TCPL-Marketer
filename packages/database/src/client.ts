import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/prisma/client.ts";

const defaultDatabaseUrl =
  "postgresql://app:app@localhost:5432/tcpl_marketer";

export function createPrismaClient(
  connectionString = process.env.DATABASE_URL ?? defaultDatabaseUrl,
): PrismaClient {
  const adapter = new PrismaPg({ connectionString });

  return new PrismaClient({ adapter });
}
