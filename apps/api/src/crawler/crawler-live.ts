import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@tcpl-marketer/database";

import { planCrawl } from "./crawl-planner.js";
import { CrawlRunner } from "./crawl-runner.js";
import { validatePublicUrl } from "./safe-http.js";
import type { DatabaseService } from "../database/database.service.js";

// Explicit, low-volume verification targets. Discovery still obeys each site's robots policy.
const DEFAULT_SITES = [
  "https://example.com", "https://example.org", "https://example.net",
  "https://www.iana.org", "https://www.w3.org", "https://www.python.org",
  "https://nodejs.org", "https://www.apache.org", "https://www.gnu.org",
  "https://www.mozilla.org",
];
const sites = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_SITES;
if (sites.length < 5 || sites.length > 10) throw new Error("Provide 5 to 10 public HTTP(S) sites");
sites.forEach(validatePublicUrl);

const database = createPrismaClient();
let passed = 0;
try {
  for (const site of sites) {
    const organization = await database.organization.create({ data: {
      name: "D013d live crawler verification", normalizedName: `d013d-live-${randomUUID()}`,
      location: "Test", normalizedLocation: "test",
    } });
    try {
      const runner = new CrawlRunner({ client: database } as DatabaseService);
      let result: Awaited<ReturnType<CrawlRunner["run"]>> | undefined;
      let failure: string | undefined;
      try {
        result = await runner.run(organization.id, site, async (url) => {
          const plan = await planCrawl(url);
          return { ...plan, pageUrls: plan.pageUrls.slice(0, 2) };
        });
      } catch (error) {
        failure = error instanceof Error ? error.message : "Unknown crawler failure";
      }
      const persisted = await database.crawlRun.findFirst({
        where: { organizationId: organization.id },
        orderBy: { startedAt: "desc" }, include: { attempts: true },
      });
      const ok = result !== undefined && result.pages.length > 0 && persisted?.status === "SUCCEEDED";
      if (ok) passed++;
      console.log(JSON.stringify({ site, ok, runStatus: persisted?.status ?? "NOT_STARTED",
        pages: result?.pages.length ?? 0,
        attempts: persisted?.attempts.map(({ status, method, httpStatus, requestedUrl }) =>
          ({ status, method, httpStatus, requestedUrl })) ?? [],
        error: failure ?? persisted?.error ?? undefined,
      }));
    } finally {
      await database.crawlRun.deleteMany({ where: { organizationId: organization.id } });
      await database.organization.delete({ where: { id: organization.id } });
    }
  }
} finally {
  await database.$disconnect();
}
console.log(`D013d public-site results: ${passed}/${sites.length} successful`);
if (passed < 5) process.exitCode = 1;
