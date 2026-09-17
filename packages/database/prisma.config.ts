import { defineConfig } from "prisma/config";

const defaultDatabaseUrl =
  "postgresql://app:app@localhost:5432/tcpl_marketer";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL ?? defaultDatabaseUrl,
  },
});
