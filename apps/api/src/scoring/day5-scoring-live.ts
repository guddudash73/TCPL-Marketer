import { createPrismaClient } from "@tcpl-marketer/database";

import { runDay5Harness } from "../acceptance/day5-harness.js";

const database = createPrismaClient();
try {
  const result = await runDay5Harness(database, process.env, "scoring");
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await database.$disconnect();
}
