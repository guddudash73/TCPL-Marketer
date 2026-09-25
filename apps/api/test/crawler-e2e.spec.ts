import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@tcpl-marketer/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { planCrawl } from "../src/crawler/crawl-planner.js";
import { CrawlRunner } from "../src/crawler/crawl-runner.js";
import { fetchContent } from "../src/crawler/page-fetcher.js";
import { readPublicPage, type SafePage } from "../src/crawler/safe-http.js";
import type { DatabaseService } from "../src/database/database.service.js";

const origin = "https://example.com";
const database = createPrismaClient();
let organizationId: string;

function page(path: string, body: string, contentType = "text/html", status = 200): SafePage {
  return { url: `${origin}${path}`, status, contentType, body: Buffer.from(body) };
}

describe("crawler end-to-end path", () => {
  beforeAll(async () => {
    const organization = await database.organization.create({ data: {
      name: "D013d Crawler E2E", normalizedName: `d013d-${randomUUID()}`,
      location: "Test", normalizedLocation: "test",
    } });
    organizationId = organization.id;
  });

  afterAll(async () => {
    if (organizationId) await database.crawlRun.deleteMany({ where: { organizationId } });
    if (organizationId) await database.organization.delete({ where: { id: organizationId } });
    await database.$disconnect();
  });

  it("plans permitted pages, fetches static and JS content, and reports persisted attempts", async () => {
    const fixtures = new Map([
      [`${origin}/robots.txt`, page("/robots.txt", "User-agent: *\nDisallow: /private", "text/plain")],
      [`${origin}/sitemap.xml`, page("/sitemap.xml", `<urlset><url><loc>${origin}/about</loc></url><url><loc>${origin}/private</loc></url><url><loc>http://127.0.0.1/</loc></url></urlset>`, "application/xml")],
      [`${origin}/`, page("/", "<title>Home</title><main>Public company homepage</main><a href='/team'>Team</a>")],
      [`${origin}/about`, page("/about", "<title>About</title><main>Public company background</main>")],
      [`${origin}/team`, page("/team", "<title>Loading</title><div id='root'></div><script src='/app.js'></script>")],
    ]);
    const read = vi.fn(async (url: string) => {
      const result = fixtures.get(url);
      if (!result) throw new Error(`Unexpected crawler request: ${url}`);
      return result;
    });
    const render = vi.fn(async () => "<title>Team</title><main>Rendered leadership information</main>");
    const runner = new CrawlRunner({ client: database } as DatabaseService);
    const result = await runner.run(organizationId, origin,
      (url) => planCrawl(url, read),
      (url) => fetchContent(url, read, render));

    expect(result.pages.map(({ url, method }) => [url, method])).toEqual([
      [`${origin}/`, "HTTP"], [`${origin}/about`, "HTTP"], [`${origin}/team`, "PLAYWRIGHT"],
    ]);
    expect(read).not.toHaveBeenCalledWith(`${origin}/private`);
    expect(read).not.toHaveBeenCalledWith("http://127.0.0.1/");
    expect(render).toHaveBeenCalledExactlyOnceWith(`${origin}/team`);
    const persisted = await database.crawlRun.findUniqueOrThrow({
      where: { id: result.runId }, include: { attempts: { orderBy: { createdAt: "asc" } } },
    });
    expect(persisted.status).toBe("SUCCEEDED");
    expect(persisted.completedAt).not.toBeNull();
    expect(persisted.attempts).toHaveLength(3);
    expect(persisted.attempts.map(({ status, method }) => [status, method])).toEqual([
      ["SUCCEEDED", "HTTP"], ["SUCCEEDED", "HTTP"], ["SUCCEEDED", "PLAYWRIGHT"],
    ]);
  });

  it.each([
    "http://localhost/", "http://127.0.0.1/", "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data/", "file:///etc/passwd",
  ])("rejects %s before creating a run or fetching", async (url) => {
    const runner = new CrawlRunner({ client: database } as DatabaseService);
    const plan = vi.fn();
    const fetch = vi.fn();
    const before = await database.crawlRun.count({ where: { organizationId } });
    await expect(runner.run(organizationId, url, plan, fetch)).rejects.toThrow();
    expect(await database.crawlRun.count({ where: { organizationId } })).toBe(before);
    expect(plan).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await expect(readPublicPage(url)).rejects.toThrow();
  });
});
