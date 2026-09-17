import { createPrismaClient } from "./client.ts";

const prisma = createPrismaClient();

try {
  const [database] = await prisma.$queryRaw<
    Array<{ database: string; server_version: string }>
  >`SELECT current_database() AS database, current_setting('server_version') AS server_version`;

  if (!database) {
    throw new Error("PostgreSQL query smoke returned no rows");
  }

  console.log(
    `Prisma query smoke passed: database=${database.database}, PostgreSQL=${database.server_version}`,
  );
} finally {
  await prisma.$disconnect();
}
