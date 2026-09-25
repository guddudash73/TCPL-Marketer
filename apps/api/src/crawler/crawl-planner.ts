import { createRequire } from "node:module";
import { XMLParser, XMLValidator } from "fast-xml-parser";

import { readPublicPage, validatePublicUrl, type SafePage } from "./safe-http.js";

// robots-parser 3.0.1 ships CommonJS with a module declaration that has no ESM call signature.
const robotsParser = createRequire(import.meta.url)("robots-parser") as typeof import("robots-parser").default;

const USER_AGENT = "TCPLMarketerBot";
const MAX_SITEMAPS = 5;
const MAX_DISCOVERED_URLS = 200;
const MAX_SELECTED_URLS = 25;
const PRIORITY_PATHS = [
  "/about", "/services", "/solutions", "/projects", "/case-studies",
  "/team", "/leadership", "/news", "/careers", "/jobs",
  "/partners", "/vendors", "/procurement", "/rfp", "/rfq",
  "/tenders", "/contact",
] as const;

export type CrawlPlan = {
  homepageUrl: string;
  robotsUrl: string;
  sitemapUrls: string[];
  pageUrls: string[];
};

type PageReader = (url: string) => Promise<SafePage>;

function sameOriginUrl(value: string, origin: string): string | undefined {
  try {
    const url = validatePublicUrl(value);
    if (url.origin !== origin) return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function priority(url: string): number {
  const path = new URL(url).pathname.toLowerCase().replace(/\/$/, "") || "/";
  if (path === "/") return 0;
  const index = PRIORITY_PATHS.findIndex((prefix) =>
    path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}-`),
  );
  return index < 0 ? PRIORITY_PATHS.length + 1 : index + 1;
}

function xmlLocations(body: string): { kind: "sitemap" | "page"; urls: string[] } {
  if (/<!DOCTYPE|<!ENTITY/i.test(body) || XMLValidator.validate(body) !== true) {
    throw new Error("Crawler sitemap XML is invalid");
  }
  const parsed: unknown = new XMLParser({ removeNSPrefix: true, parseTagValue: false }).parse(body);
  if (!parsed || typeof parsed !== "object") throw new Error("Crawler sitemap root is invalid");
  const root = parsed as Record<string, unknown>;
  const kind = "sitemapindex" in root ? "sitemap" : "urlset" in root ? "page" : undefined;
  if (!kind) throw new Error("Crawler sitemap root is invalid");
  const container = root[kind === "sitemap" ? "sitemapindex" : "urlset"];
  if (!container || typeof container !== "object") return { kind, urls: [] };
  const entries = (container as Record<string, unknown>)[kind === "sitemap" ? "sitemap" : "url"];
  const urls = (Array.isArray(entries) ? entries : entries ? [entries] : [])
    .map((entry: unknown) => entry && typeof entry === "object" ? (entry as Record<string, unknown>).loc : undefined)
    .filter((loc): loc is string => typeof loc === "string");
  return { kind, urls };
}

function homepageLinks(html: string, homepage: string): string[] {
  const urls: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi)) {
    try {
      urls.push(new URL(match[2]!.replace(/&amp;/gi, "&"), homepage).toString());
    } catch { /* Ignore malformed links from untrusted HTML. */ }
    if (urls.length >= MAX_DISCOVERED_URLS) break;
  }
  return urls;
}

/** Plan only. Fetching selected pages and enforcing per-host pacing belong to the crawl runner. */
export async function planCrawl(input: string, read: PageReader = readPublicPage): Promise<CrawlPlan> {
  const home = validatePublicUrl(input);
  const origin = home.origin;
  const homepageUrl = `${origin}/`;
  const robotsUrl = `${origin}/robots.txt`;
  const robotsPage = await read(robotsUrl);
  if (robotsPage.url !== robotsUrl) throw new Error("Crawler robots redirect changed origin or path");
  if (![200, 404, 410].includes(robotsPage.status)) throw new Error("Crawler robots policy is unavailable");
  const robots = robotsParser(robotsUrl, robotsPage.status === 200 ? robotsPage.body.toString("utf8") : "");
  const allowed = (url: string) => robots.isAllowed(url, USER_AGENT) === true;
  const discovered = new Set<string>();
  const addPage = (value: string) => {
    const url = sameOriginUrl(value, origin);
    if (url && allowed(url) && discovered.size < MAX_DISCOVERED_URLS) discovered.add(url);
  };

  const pending = [...robots.getSitemaps(), `${origin}/sitemap.xml`];
  const visited = new Set<string>();
  while (pending.length && visited.size < MAX_SITEMAPS) {
    const candidate = pending.shift()!;
    const sitemapUrl = sameOriginUrl(candidate, origin);
    if (!sitemapUrl || !allowed(sitemapUrl) || visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);
    const page = await read(sitemapUrl);
    if (page.url !== sitemapUrl) throw new Error("Crawler sitemap redirect changed origin or path");
    if (page.status === 404 || page.status === 410) continue;
    if (page.status !== 200 || !["application/xml", "text/xml", "text/plain"].includes(page.contentType)) {
      throw new Error("Crawler sitemap is unavailable");
    }
    const locations = xmlLocations(page.body.toString("utf8"));
    if (locations.kind === "sitemap") pending.push(...locations.urls.slice(0, MAX_DISCOVERED_URLS));
    else locations.urls.forEach(addPage);
  }

  if (allowed(homepageUrl)) {
    addPage(homepageUrl);
    const page = await read(homepageUrl);
    if (page.url !== homepageUrl || page.status !== 200 || page.contentType !== "text/html") {
      throw new Error("Crawler homepage is unavailable");
    }
    homepageLinks(page.body.toString("utf8"), homepageUrl).forEach(addPage);
  }

  const pageUrls = [...discovered].sort((a, b) => priority(a) - priority(b) || a.localeCompare(b, "en"))
    .slice(0, MAX_SELECTED_URLS);
  return { homepageUrl, robotsUrl, sitemapUrls: [...visited], pageUrls };
}
