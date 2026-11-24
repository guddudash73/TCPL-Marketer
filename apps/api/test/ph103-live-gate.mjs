/* global console, fetch, process, setTimeout, URL */
/**
 * PH1-03 closing gate: live acceptance of provider budget control. It makes REAL calls
 * with the keys of the local .env, against a throwaway database, under deliberately tiny caps.
 *
 *   phase main  A real discovery through the real n8n: the OpenAI plan call goes through, the web search is
 *               refused at the cap, the stage ends REVIEW_REQUIRED BUDGET_EXHAUSTED and the campaign stays
 *               healthy. One real Apollo People Search (documented 0 credits), then an Apollo call refused at
 *               a tiny cap that never reaches Apollo. The usage API is read as ADMIN and refused for others.
 *   phase tick  Automatic dispatch on (this process only) and the n8n schedule trigger running the tick: a
 *               pending campaign start is dispatched by the tick and stops at the cap the same way.
 *
 * It refuses any database not named tcpl_ph* or tcpl_test*. Run from apps/api after building, API port free:
 *   DATABASE_URL=<throwaway> node --env-file-if-exists=../../.env test/ph103-live-gate.mjs main > main.log
 */
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { createPrismaClient } from "@tcpl-marketer/database";

import { ProviderCallAuditor } from "../dist/audit/provider-call-auditor.service.js";
import { PasswordHasher } from "../dist/auth/password-hasher.js";
import { createApp } from "../dist/bootstrap.js";
import { OrchestrationService } from "../dist/orchestration/orchestration.service.js";
import { ApolloPeopleSearchAdapter } from "../dist/people/apollo-people-search.adapter.js";
import { classifyProviderError } from "../dist/provider-budget/provider-outcome.js";
import { createStandaloneGateway } from "../dist/provider-budget/standalone-gateway.js";

const phase = process.argv[2];
if (!["main", "tick"].includes(phase)) throw new Error("Usage: ph103-live-gate.mjs main|tick");

const databaseUrl = process.env.DATABASE_URL ?? "";
const databaseName = databaseUrl ? new URL(databaseUrl).pathname.slice(1) : "";
if (!/^tcpl_(ph|test)/.test(databaseName)) {
  throw new Error("Refusing to run: DATABASE_URL must name a disposable tcpl_ph* or tcpl_test* database");
}
for (const name of ["OPENAI_API_KEY", "OPENAI_RESEARCH_MODEL", "APOLLO_API_KEY", "N8N_SERVICE_SECRET"]) {
  if (!process.env[name]) throw new Error(`${name} must be set in the local .env for the live run`);
}
if (process.env.EMAIL_SEND_MODE && !["TEST_OVERRIDE", "DISABLED"].includes(process.env.EMAIL_SEND_MODE)) {
  throw new Error("Refusing to run with an email send mode that could reach a real recipient");
}

// Deliberately tiny caps, for this process only. The plan call (0.05 held) fits under 0.08; the web search
// (another 0.05) does not, so it is refused before OpenAI is reached. No prices are set, so costs stay unknown.
Object.assign(process.env, {
  BUDGET_OPENAI_RUN_USD: "0.08",
  BUDGET_OPENAI_CAMPAIGN_USD: "0.08",
  BUDGET_OPENAI_DAY_USD: "1",
  BUDGET_GLOBAL_DAY_USD: "5",
  OPENAI_ESTIMATE_CALL_USD: "0.05",
  OPENAI_WEB_SEARCH_FEE_USD: "",
  OPENAI_PRICE_INPUT_PER_MILLION_USD: "",
  OPENAI_PRICE_OUTPUT_PER_MILLION_USD: "",
  OUTBOX_MAX_ATTEMPTS: "3",
  N8N_BASE_URL: process.env.N8N_BASE_URL ?? "http://localhost:5678",
  OUTBOX_DISPATCH_ENABLED: phase === "tick" ? "true" : "false",
});

const realSecrets = [
  process.env.OPENAI_API_KEY,
  process.env.APOLLO_API_KEY,
  ...Object.entries(process.env)
    .filter(([name, value]) => (/^SERVICE_SECRET_/.test(name) || name === "N8N_SERVICE_SECRET") && (value ?? "").length >= 16)
    .map(([, value]) => value),
].filter(Boolean);

const port = 4000;
const api = `http://127.0.0.1:${port}`;
const database = createPrismaClient(databaseUrl);
const report = { phase, database: databaseName, runId: randomUUID(), startedAt: new Date().toISOString() };
const leaks = (text) => realSecrets.filter((secret) => text.includes(secret)).length;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, passed, detail) {
  report[name] = detail === undefined ? passed : { passed, detail };
  if (!passed) throw new Error(`Check failed: ${name} ${JSON.stringify(detail ?? "")}`);
}

async function n8nQuery(sql) {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync("/home/node/.n8n/database.sqlite", { readOnly: true });
    console.log(JSON.stringify(database.prepare(process.env.GATE_SQL).all()));`;
  const { stdout } = await promisify(execFile)(
    "docker",
    ["exec", "-e", "GATE_SQL", "tcpl-marketer-n8n-1", "node", "--no-warnings", "-e", script],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, GATE_SQL: sql, MSYS_NO_PATHCONV: "1" } },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

async function n8nHistoryLeaks() {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync("/home/node/.n8n/database.sqlite", { readOnly: true });
    const needles = JSON.parse(process.env.GATE_NEEDLES);
    let hits = 0, executions = 0;
    for (const row of database.prepare("select data from execution_data").iterate()) {
      executions += 1;
      for (const needle of needles) if (String(row.data).includes(needle)) hits += 1;
    }
    console.log(JSON.stringify({ executions, hits }));`;
  const { stdout } = await promisify(execFile)(
    "docker",
    ["exec", "-e", "GATE_NEEDLES", "tcpl-marketer-n8n-1", "node", "--no-warnings", "-e", script],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, GATE_NEEDLES: JSON.stringify(realSecrets), MSYS_NO_PATHCONV: "1" } },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

async function waitFor(label, probe, timeoutMs, stepMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await sleep(stepMs);
  }
}

async function signedInSession(role) {
  const email = `live-${role.toLowerCase()}-${randomUUID().slice(0, 8)}@example.test`;
  const password = `${randomBytes(18).toString("base64url")}aA1!`;
  const record = await database.role.upsert({ where: { name: role }, create: { name: role }, update: {} });
  await database.user.create({ data: { email, passwordHash: await new PasswordHasher().hash(password), roles: { create: { roleId: record.id } } } });
  const login = await fetch(`${api}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (login.status !== 200) throw new Error(`Login as ${role} returned HTTP ${login.status}`);
  const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
  return (path, method = "GET", body, extra = {}) =>
    fetch(api + path, {
      method,
      headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000", ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}

async function createCampaign(authed, name) {
  const lidar = await database.sector.findUniqueOrThrow({
    where: { slug: "lidar" },
    include: { capabilities: { include: { deliverables: true, targetProfiles: true } } },
  });
  const capability = lidar.capabilities[0];
  const created = await authed("/campaigns", "POST", {
    name,
    sectorId: lidar.id,
    capabilityIds: [capability.id],
    deliverableIds: [capability.deliverables[0].id],
    targetClientProfileIds: [capability.targetProfiles[0].id],
    countries: ["Canada"],
    states: [],
    cities: [],
    researchDepth: "STANDARD",
    targetLeadCount: 3,
    minimumScore: 70,
    automationMode: "MANUAL_REVIEW",
    dailyEmailLimit: 1,
    sequence: [{ stepNumber: 1, delayDays: 0 }],
  });
  if (created.status !== 201) throw new Error(`Create campaign returned HTTP ${created.status}`);
  return (await created.json()).id;
}

/** What the stage and ledger must show once a discovery has met the cap, whichever path started it. */
async function expectStoppedAtCap(campaignId, prefix) {
  const run = await waitFor(
    `${prefix} discovery stage to end`,
    async () => {
      const row = await database.stageRun.findFirst({ where: { campaignId } });
      return row && ["REVIEW_REQUIRED", "FAILED", "SUCCEEDED"].includes(row.status) ? row : null;
    },
    prefix === "tick" ? 240_000 : 90_000,
  );
  check(`${prefix}StageStoppedExplained`, run.status === "REVIEW_REQUIRED" && run.outcome === "BUDGET_EXHAUSTED", { status: run.status, outcome: run.outcome, lastError: run.lastError });
  const campaign = await database.campaign.findUniqueOrThrow({ where: { id: campaignId } });
  check(`${prefix}CampaignStillHealthy`, ["STARTING", "RUNNING"].includes(campaign.status), campaign.status);
  const usage = await database.providerUsage.findMany({ where: { campaignId }, orderBy: { reservedAt: "asc" } });
  const plan = usage.filter((row) => row.operation === "search-plan");
  const search = usage.filter((row) => row.operation === "web-search");
  check(`${prefix}PlanCallRecorded`, plan.length === 1 && plan[0].status === "SETTLED" && plan[0].costKnown === false, plan.map((row) => ({ status: row.status, costKnown: row.costKnown })));
  check(`${prefix}WebSearchNeverReachedOpenAI`, search.length === 0, search.length);
  const refusal = await database.auditLog.findFirst({ where: { campaignId, action: "provider.budget_refused" } });
  check(`${prefix}RefusalAudited`, refusal?.metadata?.decision === "BUDGET_EXCEEDED" && refusal.metadata.scope === "RUN", refusal?.metadata);
  const alerts = await database.providerBudgetAlert.findMany({ where: { campaignId } });
  check(`${prefix}CapAlertRaised`, alerts.some((alert) => alert.kind === "CAP_REACHED" && alert.scope === "RUN"), alerts.map((alert) => `${alert.scope}:${alert.kind}`));
  check(`${prefix}AlertAudited`, (await database.auditLog.count({ where: { campaignId, action: "provider.budget_alert" } })) >= 1);
  return { run, plan: plan[0], usage };
}

async function mainPhase(app) {
  const admin = await signedInSession("ADMIN");
  const viewer = await signedInSession("VIEWER");
  const campaignId = await createCampaign(admin, `PH1-03 live ${report.runId.slice(0, 8)}`);
  report.campaignId = campaignId;

  // 1. A real discovery through the real n8n: the plan call is real, the web search is refused at the cap.
  const correlationId = `live-trace-${randomUUID().slice(0, 8)}`;
  const started = await admin(`/campaigns/${campaignId}/start`, "POST", undefined, { "x-correlation-id": correlationId });
  const startedText = await started.text();
  if (started.status >= 500) {
    const failed = await database.auditLog.findFirst({ where: { campaignId, action: "provider.call" }, orderBy: { createdAt: "asc" } });
    report.startFailure = { http: started.status, providerCall: failed?.metadata };
  }
  check("startAccepted", started.status < 300, started.status);
  check("startResponseHoldsNoSecret", leaks(startedText) === 0);
  const stopped = await expectStoppedAtCap(campaignId, "main");
  report.mainPlanCall = { amountHeld: stopped.plan.actualAmount?.toString(), costKnown: stopped.plan.costKnown, outcome: stopped.plan.outcomeCode };

  // 2. One real Apollo People Search through the application's gateway (documented 0 credits).
  const gateway = app.get(ProviderCallAuditor);
  let apolloCalls = 0;
  const countingFetch = (...args) => {
    apolloCalls += 1;
    return globalThis.fetch(...args);
  };
  const input = {
    organization: { id: randomUUID(), name: "apollo.io", domain: "apollo.io", location: null },
    roles: [{ decisionMakerProfileId: randomUUID(), title: "Chief Executive Officer", priority: 1, seniorities: ["c_suite"], positiveTerms: [], negativeTerms: [] }],
    maximumResults: 1,
  };
  const live = await gateway
    .run({ provider: "apollo", operation: "people-search", campaignId }, (call) => new ApolloPeopleSearchAdapter(countingFetch).searchPeople(input, call))
    .then((run) => ({ ok: true, candidates: run.candidates.length, usage: run.usage }))
    .catch((error) => ({ ok: false, outcome: classifyProviderError(error)?.code ?? "UNCLASSIFIED", error: String(error?.message ?? error).slice(0, 160) }));
  report.apolloLiveCall = { ...live, requestsMade: apolloCalls };
  const apolloRow = await database.providerUsage.findFirst({ where: { campaignId, provider: "apollo" }, orderBy: { reservedAt: "asc" } });
  check("apolloCallRecorded", apolloRow !== null && apolloCalls === 1, { calls: apolloCalls, status: apolloRow?.status, costKnown: apolloRow?.costKnown });
  if (live.ok) check("apolloSearchCostedAtZeroCredits", apolloRow.status === "SETTLED" && apolloRow.costKnown === true && Number(apolloRow.actualAmount) === 0, { amount: apolloRow.actualAmount?.toString() });

  // 3. An Apollo call under a tiny cap (estimate 2 credits, cap 1) is refused and never reaches Apollo.
  const tiny = createStandaloneGateway(database, {
    ...process.env,
    BUDGET_APOLLO_RUN_CREDITS: "1",
    BUDGET_APOLLO_CAMPAIGN_CREDITS: "1",
    BUDGET_APOLLO_DAY_CREDITS: "1",
    APOLLO_ESTIMATE_CALL_CREDITS: "2",
  });
  const before = apolloCalls;
  const refused = await tiny
    .run({ provider: "apollo", operation: "people-search", campaignId }, (call) => new ApolloPeopleSearchAdapter(countingFetch).searchPeople(input, call))
    .catch((error) => error);
  check("apolloRefusedAtTinyCap", classifyProviderError(refused)?.code === "BUDGET_EXHAUSTED" && apolloCalls === before, { outcome: classifyProviderError(refused)?.code, reachedApollo: apolloCalls - before });

  // 4. The usage API as an ADMIN, and refused for everyone else.
  const report1 = await admin(`/campaigns/${campaignId}/provider-usage`);
  const body = await report1.json();
  check("usageApiAnswersAdmin", report1.status === 200, report1.status);
  const openai = body.providers.find((row) => row.provider === "openai");
  check("usageApiShowsRunAgainstCap", openai.windows.run.cap === "0.080000" && Number(openai.windows.run.used) > 0 && openai.unknownCost.calls >= 1, openai.windows.run);
  check("usageApiListsCalls", body.calls.total >= 2 && body.calls.items.every((item) => !("callKey" in item)), body.calls.total);
  check("usageApiShowsAlerts", body.alerts.length >= 1 && body.alerts.every((alert) => typeof alert.reason === "string" && !/BUDGET_|API_KEY|sk-/.test(alert.reason)), body.alerts.map((alert) => alert.reason));
  report.usageApiSummary = { openaiRun: openai.windows.run, unknownCost: openai.unknownCost, alerts: body.alerts.length };
  check("usageApiRefusesViewer", (await viewer(`/campaigns/${campaignId}/provider-usage`)).status === 403);
  check("usageApiRefusesAnonymous", (await fetch(`${api}/campaigns/${campaignId}/provider-usage`)).status === 401);
  check("systemUsageApiAnswersAdmin", (await admin("/provider-usage")).status === 200);

  // 5. No real secret anywhere durable or visible.
  const everything = JSON.stringify([
    body,
    await database.auditLog.findMany({ where: { campaignId } }),
    await database.providerUsage.findMany({ where: { campaignId } }),
    await database.providerBudgetAlert.findMany({ where: { campaignId } }),
    await database.stageRun.findMany({ where: { campaignId } }),
  ]);
  check("durableRecordsHoldNoSecret", leaks(everything) === 0);
  const history = await n8nHistoryLeaks();
  check("n8nHistoryHoldsNoSecret", history.hits === 0, history);
}

async function tickPhase(app) {
  const admin = await signedInSession("ADMIN");
  const campaignId = await createCampaign(admin, `PH1-03 tick ${report.runId.slice(0, 8)}`);
  report.campaignId = campaignId;
  const user = await database.user.findFirstOrThrow({ where: { email: { startsWith: "live-admin-" } }, orderBy: { createdAt: "desc" } });
  const scheduleRuns = () => n8nQuery("select id, mode, status, startedAt from execution_entity where workflowId = 'PH101bOutboxDispatch' order by id desc limit 20");
  const baseline = new Set((await scheduleRuns()).map((row) => row.id));
  const nonces = () => database.serviceRequestNonce.count({ where: { callerId: "n8n-outbox-dispatch" } });
  const noncesBefore = await nonces();

  // A start that is recorded but not dispatched: only the tick may publish it.
  const orchestration = app.get(OrchestrationService);
  const prepared = await orchestration.prepareCampaignStart(campaignId, user.id);
  check("startRecordedPending", prepared.event.status === "PENDING", prepared.event.status);

  const published = await waitFor(
    "the scheduled tick to dispatch the start",
    async () => {
      const event = await database.outboxEvent.findUniqueOrThrow({ where: { id: prepared.event.id } });
      return event.status === "PUBLISHED" ? event : null;
    },
    240_000,
    3_000,
  );
  check("tickDispatchedTheEvent", published.status === "PUBLISHED" && published.attempts >= 1, { attempts: published.attempts });
  const fresh = (await scheduleRuns()).filter((row) => !baseline.has(row.id));
  report.scheduledExecutions = fresh.map((row) => ({ id: row.id, mode: row.mode, status: row.status, startedAt: row.startedAt }));
  check("scheduleTriggerFired", fresh.some((row) => row.mode === "trigger" && row.status === "success"), report.scheduledExecutions);
  check("tickRanMoreThanOnceOrDispatched", (await nonces()) - noncesBefore >= 1, { newTickRequests: (await nonces()) - noncesBefore });
  const stopped = await expectStoppedAtCap(campaignId, "tick");
  report.tickPlanCall = { costKnown: stopped.plan.costKnown, outcome: stopped.plan.outcomeCode };
  check("tickRunHoldsNoSecret", leaks(JSON.stringify(await database.auditLog.findMany({ where: { campaignId } }))) === 0);
  check("n8nHistoryHoldsNoSecretAfterTick", (await n8nHistoryLeaks()).hits === 0);
}

async function main() {
  const app = await createApp();
  await app.listen(port);
  try {
    if (phase === "main") await mainPhase(app);
    else await tickPhase(app);
    report.result = "PASS";
  } finally {
    await app.close();
    await database.$disconnect();
  }
  report.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(report, null, 1));
}

main().catch(async (error) => {
  report.result = "FAIL";
  console.log(JSON.stringify(report, null, 1));
  console.error(error instanceof Error ? error.message : "Live gate failed");
  process.exit(1);
});
