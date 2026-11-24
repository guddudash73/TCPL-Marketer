import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ProviderBypassError,
  issueProviderCallContext,
  requireProviderCallContext,
} from "../src/provider-budget/provider-call-context.js";

/**
 * The no-bypass proof (PH1-03c). Provider adapters refuse a call without a
 * gateway-issued context at run time; this test keeps the code that can reach a
 * provider closed at build time. A new module that calls a provider directly
 * fails here until it goes through the gateway or is added to a list below with a
 * written reason.
 */
const ADAPTERS = [
  "src/search/openai-search.adapter.ts",
  "src/company-intelligence/openai-claim-extraction.adapter.ts",
  "src/people/public-people-search.adapter.ts",
  "src/people/apollo-people-search.adapter.ts",
];

/** Files that may call the OpenAI Responses API: the three OpenAI adapters. */
const RESPONSES_API_CALLERS = new Set(ADAPTERS.filter((file) => !file.includes("apollo")));

/**
 * Files that may use the global fetch. The n8n adapter calls our own orchestrator, not a
 * provider. people.module.ts hands the global fetch to the Apollo adapter as an injected
 * function. The three live scripts call our own API or n8n webhooks, or (apollo-people-live)
 * pass the global fetch to the adapter, which still needs a gateway context to use it.
 */
const GLOBAL_FETCH_ALLOWED = new Set([
  "src/orchestration/n8n-orchestration.adapter.ts",
  "src/people/people.module.ts",
  "src/people/apollo-people-live.ts",
  "src/search/day3-live.ts",
  "src/company-intelligence/day4-evidence-live.ts",
]);

/** Only the gateway and the file that defines the context may mint one. */
const CONTEXT_ISSUERS = new Set([
  "src/provider-budget/provider-call-context.ts",
  "src/audit/provider-call-auditor.service.ts",
]);

const CRAWL_NETWORK_NAMES = /\b(readPublicPage|renderJavaScriptPage|fetchContent|planCrawl|resolvePublicTarget)\b/;
const CRAWL_NETWORK_MODULES = /from\s+["'][^"']*\/(safe-http|page-fetcher|crawl-planner)\.js["']/;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

export function findBypasses(files: Record<string, string>): string[] {
  const violations: string[] = [];
  for (const [path, raw] of Object.entries(files)) {
    const source = stripComments(raw);
    if (/\.responses\.(parse|create|stream)\s*\(/.test(source) && !RESPONSES_API_CALLERS.has(path)) {
      violations.push(`${path}: calls the OpenAI Responses API outside an adapter`);
    }
    if (!path.startsWith("src/crawler/") && (CRAWL_NETWORK_MODULES.test(source) || CRAWL_NETWORK_NAMES.test(source))) {
      violations.push(`${path}: reaches the crawler's network functions from outside src/crawler`);
    }
    const usesGlobalFetch = /globalThis\.fetch/.test(source) || /(^|[^\w.$])fetch\s*\(/.test(source);
    if (usesGlobalFetch && !path.startsWith("src/crawler/") && !GLOBAL_FETCH_ALLOWED.has(path)) {
      violations.push(`${path}: uses the global fetch directly`);
    }
    if (/\bissueProviderCallContext\b/.test(source) && !CONTEXT_ISSUERS.has(path)) {
      violations.push(`${path}: mints a provider call context outside the gateway`);
    }
  }
  for (const adapter of ADAPTERS) {
    const source = files[adapter];
    if (source !== undefined && !/requireProviderCallContext\s*\(/.test(stripComments(source))) {
      violations.push(`${adapter}: does not require a gateway-issued context`);
    }
  }
  return violations;
}

function readSources(): Record<string, string> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const out: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const full = join(directory, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out[relative(root, full).replaceAll("\\", "/")] = readFileSync(full, "utf8");
    }
  };
  walk(join(root, "src"));
  return out;
}

describe("provider gateway bypass proof", () => {
  const sources = readSources();

  it("finds every adapter and the gateway in the scanned tree", () => {
    for (const adapter of ADAPTERS) expect(sources[adapter], adapter).toBeDefined();
    expect(sources["src/audit/provider-call-auditor.service.ts"]).toBeDefined();
    expect(Object.keys(sources).length).toBeGreaterThan(80);
  });

  it("finds no module that reaches a provider outside the gateway", () => {
    expect(findBypasses(sources)).toEqual([]);
  });

  it("fails on each kind of deliberately added bypass", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["src/people/rogue-search.ts", "const r = await client.responses.parse({ model });", /Responses API outside an adapter/],
      ["src/orchestration/rogue-crawl.ts", 'import { readPublicPage } from "../crawler/safe-http.js";\nawait readPublicPage(url);', /crawler's network functions/],
      ["src/orchestration/rogue-planner.ts", "const plan = await planCrawl(url);", /crawler's network functions/],
      ["src/people/rogue-apollo.ts", 'await fetch("https://api.apollo.io/api/v1/mixed_people/api_search");', /global fetch/],
      ["src/people/rogue-global.ts", "const request = globalThis.fetch;", /global fetch/],
      ["src/people/rogue-context.ts", 'import { issueProviderCallContext } from "../provider-budget/provider-call-context.js";', /mints a provider call context/],
    ];
    for (const [path, code, expected] of cases) {
      const found = findBypasses({ ...sources, [path]: code });
      expect(found.some((line) => line.startsWith(path) && expected.test(line)), `${path}: ${found.join(" | ")}`).toBe(true);
    }
  });

  it("fails when an adapter stops requiring the gateway context", () => {
    const adapter = ADAPTERS[0]!;
    const weakened = sources[adapter]!.replace(/requireProviderCallContext\s*\(/g, "(");
    expect(findBypasses({ ...sources, [adapter]: weakened }).some((line) => line.includes(adapter))).toBe(true);
  });

  it("ignores a provider call that appears only in a comment", () => {
    const found = findBypasses({ ...sources, "src/people/note.ts": "// do not call client.responses.parse( or fetch( here\n/* readPublicPage() */ export const x = 1;" });
    expect(found).toEqual([]);
  });

  it("issues a context only through the gateway module and checks the provider", () => {
    const context = issueProviderCallContext("apollo", "people-search");
    expect(requireProviderCallContext(context, "apollo")).toBe(context);
    expect(() => requireProviderCallContext(context, "openai")).toThrow(ProviderBypassError);
    expect(() => requireProviderCallContext({ ...context }, "apollo")).toThrow(ProviderBypassError);
    context.recordRequest(3);
    expect(context.requests).toBe(3);
  });
});
