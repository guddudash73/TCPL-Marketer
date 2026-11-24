/**
 * Website research cache configuration (PH1-03e, plan section 83).
 *
 * A site crawled successfully within the freshness period is not crawled again.
 * The period is read from the environment once at startup; an invalid value
 * refuses to start the application, and a message names the variable only.
 */
export const WEBSITE_CACHE_CONFIG = Symbol("WEBSITE_CACHE_CONFIG");

export interface WebsiteCacheConfig {
  /** Days a successful crawl stays fresh. Zero turns cache reads off. */
  freshnessDays: number;
}

export class WebsiteCacheConfigError extends Error {
  constructor(readonly variable: string) {
    super(`Website cache configuration is invalid: ${variable}`);
    this.name = "WebsiteCacheConfigError";
  }
}

const DEFAULT_FRESHNESS_DAYS = 14;
const MAX_FRESHNESS_DAYS = 365;

export function readWebsiteCacheConfig(environment: NodeJS.ProcessEnv = process.env): WebsiteCacheConfig {
  const raw = environment.WEBSITE_CACHE_FRESHNESS_DAYS;
  if (raw === undefined || raw.trim() === "") return { freshnessDays: DEFAULT_FRESHNESS_DAYS };
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(value) || value < 0 || value > MAX_FRESHNESS_DAYS) {
    throw new WebsiteCacheConfigError("WEBSITE_CACHE_FRESHNESS_DAYS");
  }
  return { freshnessDays: value };
}
