import * as cheerio from "cheerio";
import { chromium } from "playwright";

import { readPublicPage, validatePublicUrl, type SafePage } from "./safe-http.js";

const BROWSER_TYPES = [
  "text/html", "text/plain", "application/xhtml+xml", "text/css",
  "text/javascript", "application/javascript", "application/json",
] as const;
const MAX_BROWSER_REQUESTS = 20;
const MAX_BROWSER_BYTES = 8_000_000;
const BROWSER_TIMEOUT_MS = 8_000;

export type FetchedContent = {
  url: string;
  httpStatus: number;
  method: "HTTP" | "PLAYWRIGHT";
  title: string;
  text: string;
};

type Reader = (url: string) => Promise<SafePage>;
type Renderer = (url: string) => Promise<string>;

export class CrawlFetchError extends Error {
  constructor(readonly method: "HTTP" | "PLAYWRIGHT", cause: unknown) {
    super(cause instanceof Error ? cause.message : "Crawler page fetch failed", { cause });
  }
}

export function cleanHtml(html: string): { title: string; text: string; needsJavaScript: boolean } {
  const $ = cheerio.load(html);
  const title = $("title").first().text().trim().slice(0, 500);
  const hasScripts = $("script").length > 0;
  $("script, style, noscript, template, svg, nav, footer, header").remove();
  const text = $("body").text().replace(/\s+/g, " ").trim().slice(0, 100_000);
  return { title, text, needsJavaScript: hasScripts && text.length < 120 };
}

export async function fetchContent(
  requestedUrl: string,
  read: Reader = readPublicPage,
  render: Renderer = renderJavaScriptPage,
): Promise<FetchedContent> {
  const expectedOrigin = validatePublicUrl(requestedUrl).origin;
  const page = await read(requestedUrl);
  if (validatePublicUrl(page.url).origin !== expectedOrigin) {
    throw new Error("Crawler page redirected outside the planned origin");
  }
  if (page.status !== 200 || !["text/html", "application/xhtml+xml"].includes(page.contentType)) {
    throw new Error(`Crawler page is unavailable (${page.status})`);
  }
  const staticContent = cleanHtml(page.body.toString("utf8"));
  if (!staticContent.needsJavaScript) {
    return { url: page.url, httpStatus: page.status, method: "HTTP", title: staticContent.title, text: staticContent.text };
  }
  try {
    const rendered = cleanHtml(await render(page.url));
    if (!rendered.text) throw new Error("Crawler rendered page has no content");
    return { url: page.url, httpStatus: page.status, method: "PLAYWRIGHT", title: rendered.title, text: rendered.text };
  } catch (error) {
    throw new CrawlFetchError("PLAYWRIGHT", error);
  }
}

/** Browser traffic is fulfilled exclusively by the DNS-pinned, bounded HTTP transport. */
export async function renderJavaScriptPage(
  url: string,
  read: typeof readPublicPage = readPublicPage,
): Promise<string> {
  const origin = validatePublicUrl(url).origin;
  let requests = 0;
  let bytes = 0;
  const browser = await chromium.launch({
    headless: true,
    proxy: { server: "http://127.0.0.1:9", bypass: "" },
  });
  try {
    const context = await browser.newContext({
      serviceWorkers: "block",
      acceptDownloads: false,
      javaScriptEnabled: true,
    });
    try {
      await context.routeWebSocket("**/*", (socket) => socket.close());
      await context.route("**/*", async (route) => {
        const request = route.request();
        try {
          const target = validatePublicUrl(request.url());
          if (target.origin !== origin || request.method() !== "GET" || ++requests > MAX_BROWSER_REQUESTS) {
            await route.abort();
            return;
          }
          const resource = await read(target.toString(), undefined, BROWSER_TYPES);
          if (validatePublicUrl(resource.url).origin !== origin ||
              (bytes += resource.body.length) > MAX_BROWSER_BYTES) {
            await route.abort();
            return;
          }
          await route.fulfill({ status: resource.status, contentType: resource.contentType, body: resource.body });
        } catch {
          await route.abort();
        }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: BROWSER_TIMEOUT_MS });
      await page.waitForFunction("document.body?.innerText.trim().length >= 120", null, {
        timeout: Math.min(2_000, BROWSER_TIMEOUT_MS),
      }).catch(() => undefined);
      return await page.content();
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
