/** Test-only provider budget values: generous, so unrelated tests are never refused. */
export const TEST_BUDGET_ENV: Record<string, string> = {
  BUDGET_GLOBAL_DAY_USD: "100000",
  BUDGET_OPENAI_RUN_USD: "100000",
  BUDGET_OPENAI_CAMPAIGN_USD: "100000",
  BUDGET_OPENAI_DAY_USD: "100000",
  OPENAI_ESTIMATE_CALL_USD: "0.05",
  BUDGET_APOLLO_RUN_CREDITS: "100000",
  BUDGET_APOLLO_CAMPAIGN_CREDITS: "100000",
  BUDGET_APOLLO_DAY_CREDITS: "100000",
  APOLLO_ESTIMATE_CALL_CREDITS: "1",
  APOLLO_USD_PER_CREDIT: "0.10",
  PROVIDER_RATE_OPENAI_PER_MINUTE: "100000",
  PROVIDER_RATE_APOLLO_PER_MINUTE: "100000",
  PROVIDER_RATE_CRAWL_PER_MINUTE: "100000",
  PROVIDER_CONCURRENCY_OPENAI: "1000",
  PROVIDER_CONCURRENCY_APOLLO: "1000",
  PROVIDER_CONCURRENCY_CRAWL: "1000",
};

export function installTestBudgetEnv(environment: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(TEST_BUDGET_ENV)) {
    if (environment[name] === undefined) environment[name] = value;
  }
}
