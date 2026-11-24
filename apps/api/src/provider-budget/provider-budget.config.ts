import { parseMicro } from "./money.js";

/**
 * Provider spend and rate configuration (PH1-03a).
 *
 * Every value comes from the environment and is validated once at startup. A
 * paid provider that is configured (its API key is present) but has no valid
 * cap refuses to start the application; a paid provider without caps that is
 * called anyway gets CAP_NOT_CONFIGURED. Messages name variables, never values.
 */
export const PROVIDERS = ["openai", "apollo", "crawl"] as const;
export type ProviderName = (typeof PROVIDERS)[number];
export type UsageUnit = "USD" | "CREDITS" | "REQUESTS";
export type BudgetScope = "RUN" | "CAMPAIGN" | "DAY" | "GLOBAL_DAY";

export function isProviderName(value: string): value is ProviderName {
  return (PROVIDERS as readonly string[]).includes(value);
}

export interface ProviderPolicy {
  provider: ProviderName;
  unit: UsageUnit;
  paid: boolean;
  /** Caps in micro-units of `unit`; null means that scope is not capped. */
  caps: { run: bigint | null; campaign: bigint | null; day: bigint | null };
  /** Required variables that are missing or invalid; non-empty means calls fail closed. */
  missing: string[];
  requestsPerMinute: number;
  maxConcurrent: number;
  /** Amount reserved for one call, in micro-units of `unit`. */
  estimatePerCall: bigint;
  /** OpenAI only. Null prices make the cost unknown rather than zero. */
  pricing: {
    inputPerMillionUsd: bigint | null;
    outputPerMillionUsd: bigint | null;
    webSearchFeeUsd: bigint | null;
  };
  /** Apollo only: micro-USD per credit, used for the global USD cap. */
  usdPerCredit: bigint | null;
}

export interface ProviderBudgetConfig {
  providers: Record<ProviderName, ProviderPolicy>;
  /** Cap on total USD across all providers per UTC day, in micro-USD. */
  globalDayUsd: bigint | null;
  reservationTtlSeconds: number;
  /** A reservation older than this no longer holds an in-flight slot, though it still counts toward spend. */
  inflightSeconds: number;
  /** Share of a cap, in percent, at which a threshold alert is raised (the cap itself always alerts). */
  alertPercent: number;
}

export class ProviderBudgetConfigError extends Error {
  constructor(readonly variables: string[]) {
    super(`Provider budget configuration is incomplete or invalid: ${variables.join(", ")}`);
    this.name = "ProviderBudgetConfigError";
  }
}

type Environment = NodeJS.ProcessEnv;

function requiredMicro(environment: Environment, name: string, problems: string[]): bigint | null {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") {
    problems.push(name);
    return null;
  }
  const parsed = parseMicro(raw);
  if (parsed === null || parsed <= 0n) {
    problems.push(name);
    return null;
  }
  return parsed;
}

function optionalMicro(environment: Environment, name: string, problems: string[]): bigint | null {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return null;
  const parsed = parseMicro(raw);
  if (parsed === null || parsed <= 0n) {
    problems.push(name);
    return null;
  }
  return parsed;
}

function integerOption(
  environment: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
  problems: string[],
): number {
  const raw = environment[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    problems.push(name);
    return fallback;
  }
  return value;
}

const DEFAULT_LIMITS: Record<ProviderName, { perMinute: number; concurrent: number }> = {
  openai: { perMinute: 60, concurrent: 8 },
  apollo: { perMinute: 30, concurrent: 4 },
  crawl: { perMinute: 600, concurrent: 20 },
};

const PAID: Record<ProviderName, boolean> = { openai: true, apollo: true, crawl: false };
const UNIT: Record<ProviderName, UsageUnit> = { openai: "USD", apollo: "CREDITS", crawl: "REQUESTS" };
/** A paid provider is "configured", and so must have caps, once its key is present. */
const KEY_VARIABLE: Partial<Record<ProviderName, string>> = {
  openai: "OPENAI_API_KEY",
  apollo: "APOLLO_API_KEY",
};

export function readProviderBudgetConfig(environment: Environment = process.env): ProviderBudgetConfig {
  const invalid: string[] = [];
  const policies = {} as Record<ProviderName, ProviderPolicy>;

  const reservationTtlSeconds = integerOption(
    environment,
    "PROVIDER_RESERVATION_TTL_SECONDS",
    900,
    30,
    86_400,
    invalid,
  );

  const inflightSeconds = integerOption(environment, "PROVIDER_INFLIGHT_SECONDS", 300, 10, 3_600, invalid);
  const alertPercent = integerOption(environment, "BUDGET_ALERT_PERCENT", 80, 1, 99, invalid);

  for (const provider of PROVIDERS) {
    const upper = provider.toUpperCase();
    const unit = UNIT[provider];
    const paid = PAID[provider];
    const problems: string[] = [];

    const readCap = (name: string): bigint | null =>
      paid ? requiredMicro(environment, name, problems) : optionalMicro(environment, name, invalid);
    const caps = {
      run: readCap(`BUDGET_${upper}_RUN_${unit}`),
      campaign: readCap(`BUDGET_${upper}_CAMPAIGN_${unit}`),
      day: readCap(`BUDGET_${upper}_DAY_${unit}`),
    };

    const estimate =
      provider === "crawl" ? 1_000_000n : requiredMicro(environment, `${upper}_ESTIMATE_CALL_${unit}`, problems);

    const pricing = {
      inputPerMillionUsd:
        provider === "openai" ? optionalMicro(environment, "OPENAI_PRICE_INPUT_PER_MILLION_USD", invalid) : null,
      outputPerMillionUsd:
        provider === "openai" ? optionalMicro(environment, "OPENAI_PRICE_OUTPUT_PER_MILLION_USD", invalid) : null,
      webSearchFeeUsd:
        provider === "openai" ? optionalMicro(environment, "OPENAI_WEB_SEARCH_FEE_USD", invalid) : null,
    };
    const usdPerCredit = provider === "apollo" ? requiredMicro(environment, "APOLLO_USD_PER_CREDIT", problems) : null;

    const limits = DEFAULT_LIMITS[provider];
    policies[provider] = {
      provider,
      unit,
      paid,
      caps,
      missing: [...new Set(problems)],
      requestsPerMinute: integerOption(environment, `PROVIDER_RATE_${upper}_PER_MINUTE`, limits.perMinute, 1, 100_000, invalid),
      maxConcurrent: integerOption(environment, `PROVIDER_CONCURRENCY_${upper}`, limits.concurrent, 1, 1_000, invalid),
      estimatePerCall: estimate ?? 0n,
      pricing,
      usdPerCredit,
    };
  }

  const globalProblems: string[] = [];
  const globalDayUsd = requiredMicro(environment, "BUDGET_GLOBAL_DAY_USD", globalProblems);

  const refused = [...invalid];
  let anyPaidConfigured = false;
  for (const provider of PROVIDERS) {
    const keyName = KEY_VARIABLE[provider];
    if (keyName && environment[keyName]) {
      anyPaidConfigured = true;
      refused.push(...policies[provider].missing);
    }
  }
  if (anyPaidConfigured) refused.push(...globalProblems);
  if (refused.length > 0) throw new ProviderBudgetConfigError([...new Set(refused)]);

  return { providers: policies, globalDayUsd, reservationTtlSeconds, inflightSeconds, alertPercent };
}
