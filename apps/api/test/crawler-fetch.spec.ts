import { randomUUID } from "node:crypto";

import { createPrismaClient } from "@tcpl-marketer/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CrawlRunner } from "../src/crawler/crawl-runner.js";
import { CrawlFetchError, fetchContent, renderJavaScriptPage } from "../src/crawler/page-fetcher.js";
import type { SafePage } from "../src/crawler/safe-http.js";
import type { DatabaseService } from "../src/database/database.service.js";

const origin = "https://example.com";
const database = createPrismaClient();
const browserIt = process.env.PLAYWRIGHT_BROWSERS_PATH ? it : it.skip;
let organizationId: string;

function html(body: string, url = `${origin}/`): SafePage {
  return { url, status: 200, contentType: "text/html", body: Buffer.from(body) };
}

describe("crawler page fetching", () => {
  it("extracts static content without launching a browser", async () => {
    const render = vi.fn();
    const result = await fetchContent(`${origin}/`, async () => html(
      "<title>Example</title><nav>Ignore</nav><main>Useful company information</main>",
    ), render);
    expect(result).toMatchObject({ method: "HTTP", title: "Example", text: "Useful company information" });
    expect(render).not.toHaveBeenCalled();
  });

  it("uses the renderer only for script-heavy empty shells", async () => {
    const render = vi.fn(async () => "<title>Rendered</title><main>JavaScript supplied the company content</main>");
    const result = await fetchContent(`${origin}/`, async () => html(
      "<title>Loading</title><div id='root'></div><script src='/app.js'></script>",
    ), render);
    expect(result).toMatchObject({ method: "PLAYWRIGHT", title: "Rendered", text: "JavaScript supplied the company content" });
    expect(render).toHaveBeenCalledOnce();
  });

  it("rejects a redirect to another origin before rendering", async () => {
    await expect(fetchContent(`${origin}/`, async () => html("<p>Other</p>", "https://other.example.org/")))
      .rejects.toThrow("outside the planned origin");
  });

  it("identifies a failed browser fallback", async () => {
    await expect(fetchContent(`${origin}/`, async () => html("<div id='root'></div><script></script>"),
      async () => { throw new Error("Browser timed out"); }))
      .rejects.toMatchObject({ method: "PLAYWRIGHT", message: "Browser timed out" });
  });

  browserIt("renders an external same-origin script through bounded transport", async () => {
    const urls: string[] = [];
    const rendered = await renderJavaScriptPage(`${origin}/`, async (url) => {
      urls.push(url);
      if (url === `${origin}/`) return html("<div id='root'></div><script src='/app.js'></script>");
      if (url === `${origin}/app.js`) return {
        url, status: 200, contentType: "application/javascript",
        body: Buffer.from("document.getElementById('root').textContent = 'Rendered company information '.repeat(6)"),
      };
      throw new Error(`Unexpected browser request: ${url}`);
    });
    expect(rendered).toContain("Rendered company information");
    expect(urls).toEqual([`${origin}/`, `${origin}/app.js`]);
  });

  browserIt("does not hand a cross-origin script request to the HTTP reader", async () => {
    const urls: string[] = [];
    await renderJavaScriptPage(`${origin}/`, async (url) => {
      urls.push(url);
      return html("<main>Public text</main><script>fetch('https://other.example.org/secret')</script>");
    });
    expect(urls).toEqual([`${origin}/`]);
  });
});

describe("crawl run persistence", () => {
  beforeAll(async () => {
    const organization = await database.organization.create({ data: {
      name: "D013c Fixture", normalizedName: `d013c-${randomUUID()}`,
      location: "Test", normalizedLocation: "test",
    } });
    organizationId = organization.id;
  });

  afterAll(async () => {
    if (organizationId) await database.crawlRun.deleteMany({ where: { organizationId } });
    if (organizationId) await database.organization.delete({ where: { id: organizationId } });
    await database.$disconnect();
  });

  it("stores successful and failed attempts and completes the run", async () => {
    const runner = new CrawlRunner({ client: database } as DatabaseService);
    const run = await runner.run(organizationId, origin,
      async () => ({ homepageUrl: `${origin}/`, robotsUrl: `${origin}/robots.txt`, sitemapUrls: [],
        pageUrls: [`${origin}/`, `${origin}/missing`] }),
      async (url) => {
        if (url.endsWith("missing")) throw new CrawlFetchError("PLAYWRIGHT", new Error("Page missing"));
        return { url, httpStatus: 200, method: "HTTP", title: "Example", text: "Useful content" };
      });
    expect(run.pages).toHaveLength(1);
    const persisted = await database.crawlRun.findUniqueOrThrow({ where: { id: run.runId }, include: { attempts: true } });
    expect(persisted.status).toBe("SUCCEEDED");
    expect(persisted.completedAt).not.toBeNull();
    expect(persisted.attempts.map((attempt) => attempt.status).sort()).toEqual(["FAILED", "SUCCEEDED"]);
    expect(persisted.attempts.find((attempt) => attempt.status === "SUCCEEDED")?.textLength).toBe(14);
    expect(persisted.attempts.find((attempt) => attempt.status === "FAILED")?.method).toBe("PLAYWRIGHT");
  });

  it("records a planning failure as a failed run", async () => {
    const runner = new CrawlRunner({ client: database } as DatabaseService);
    const before = await database.crawlRun.count({ where: { organizationId } });
    await expect(runner.run(organizationId, origin, async () => { throw new Error("Robots denied"); }))
      .rejects.toThrow("Robots denied");
    const runs = await database.crawlRun.findMany({ where: { organizationId }, orderBy: { startedAt: "desc" } });
    expect(runs).toHaveLength(before + 1);
    expect(runs[0]?.status).toBe("FAILED");
    expect(runs[0]?.error).toBe("Robots denied");
  });
});
