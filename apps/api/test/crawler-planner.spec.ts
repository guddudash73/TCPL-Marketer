import { describe, expect, it, vi } from "vitest";

import { planCrawl } from "../src/crawler/crawl-planner.js";
import type { SafePage } from "../src/crawler/safe-http.js";

const origin = "https://example.com";
function page(path: string, body: string, contentType = "application/xml", status = 200): SafePage {
  return { url: `${origin}${path}`, status, contentType, body: Buffer.from(body) };
}
function reader(fixtures: SafePage[]) {
  const byUrl = new Map(fixtures.map((fixture) => [fixture.url, fixture]));
  return vi.fn(async (url: string) => {
    const result = byUrl.get(url);
    if (!result) throw new Error(`Unexpected fetch: ${url}`);
    return result;
  });
}

describe("crawler discovery planning", () => {
  it("obeys robots, follows a bounded sitemap index, and sorts permitted URLs", async () => {
    const read = reader([
      page("/robots.txt", [
        "User-agent: TCPLMarketerBot", "Disallow: /private", "Disallow: /jobs",
        "Sitemap: https://example.com/map.xml", "Sitemap: http://127.0.0.1/secret.xml",
      ].join("\n"), "text/plain"),
      page("/map.xml", `<sitemapindex><sitemap><loc>${origin}/pages.xml</loc></sitemap></sitemapindex>`),
      page("/pages.xml", `<urlset>
        <url><loc>${origin}/contact</loc></url><url><loc>${origin}/private</loc></url>
        <url><loc>${origin}/services/ai</loc></url><url><loc>http://127.0.0.1/</loc></url>
        <url><loc>https://other.example.org/about</loc></url>
      </urlset>`),
      page("/sitemap.xml", "", "application/xml", 404),
      page("/", `<a href="/about">About</a><a href='/jobs'>Jobs</a><a href="/services/ai">Services</a><a href="https://other.example.org/">Other</a>`, "text/html"),
    ]);
    const plan = await planCrawl(origin, read);
    expect(plan.pageUrls).toEqual([
      `${origin}/`, `${origin}/about`, `${origin}/services/ai`, `${origin}/contact`,
    ]);
    expect(plan.sitemapUrls).toEqual([`${origin}/map.xml`, `${origin}/sitemap.xml`, `${origin}/pages.xml`]);
    expect(read).not.toHaveBeenCalledWith("http://127.0.0.1/secret.xml");
  });

  it("never fetches a homepage forbidden by robots", async () => {
    const read = reader([
      page("/robots.txt", "User-agent: *\nDisallow: /", "text/plain"),
    ]);
    expect((await planCrawl(origin, read)).pageUrls).toEqual([]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("uses homepage links when robots and sitemap are absent", async () => {
    const read = reader([
      page("/robots.txt", "", "text/plain", 404),
      page("/sitemap.xml", "", "application/xml", 404),
      page("/", `<a href="/team">Team</a><a href="/about?x=1&amp;y=2#bio">About</a>`, "text/html"),
    ]);
    expect((await planCrawl(origin, read)).pageUrls).toEqual([
      `${origin}/`, `${origin}/about?x=1&y=2`, `${origin}/team`,
    ]);
  });

  it("fails closed when robots is unavailable or redirects away", async () => {
    await expect(planCrawl(origin, reader([page("/robots.txt", "", "text/plain", 503)])))
      .rejects.toThrow("robots policy");
    const redirect = vi.fn(async () => page("/other.txt", "User-agent: *\nAllow: /", "text/plain"));
    await expect(planCrawl(origin, redirect)).rejects.toThrow("robots redirect");
  });

  it("rejects malformed or entity-bearing sitemap XML", async () => {
    for (const xml of ["<urlset><url>", '<!DOCTYPE x [<!ENTITY e "boom">]><urlset/>']) {
      const read = reader([
        page("/robots.txt", "User-agent: *\nAllow: /", "text/plain"),
        page("/sitemap.xml", xml),
      ]);
      await expect(planCrawl(origin, read)).rejects.toThrow("sitemap XML");
    }
  });

  it("limits sitemap fetches and selected pages", async () => {
    const sitemapIndex = `<sitemapindex>${Array.from({ length: 20 }, (_, i) =>
      `<sitemap><loc>${origin}/map-${i}.xml</loc></sitemap>`).join("")}</sitemapindex>`;
    const fixtures = [
      page("/robots.txt", "User-agent: *\nAllow: /", "text/plain"),
      page("/sitemap.xml", sitemapIndex),
      page("/", "", "text/html"),
      ...Array.from({ length: 4 }, (_, i) => page(`/map-${i}.xml`, `<urlset>${Array.from({ length: 50 }, (_, n) =>
        `<url><loc>${origin}/services/item-${i}-${n}</loc></url>`).join("")}</urlset>`)),
    ];
    const read = reader(fixtures);
    const plan = await planCrawl(origin, read);
    expect(plan.sitemapUrls).toHaveLength(5);
    expect(plan.pageUrls).toHaveLength(25);
    expect(read).toHaveBeenCalledTimes(7);
  });
});
