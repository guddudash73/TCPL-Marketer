/* global console, fetch, process, URL */
/**
 * PH1-02 closing-gate run. A fresh campaign is started through the supported API and the real n8n;
 * the provider fails with an error that echoes fake secrets. The run proves the failure can be
 * traced by correlation ID across the response, outbox event, stage run, audit rows, Sentry event
 * and n8n execution history, and that no secret appears in any of them. It then sends one
 * valid signed request followed by a replay, a tampered body and a wrong-scope call.
 * It makes no paid call and refuses any database not named tcpl_ph* or tcpl_test*.
 *
 * Run from apps/api after building, with the API port free. The shell scans this process's own log:
 *   DATABASE_URL=<throwaway> node --env-file-if-exists=../../.env test/ph102-gate-local.mjs > run.log
 */
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { createPrismaClient } from "@tcpl-marketer/database";
import { signServiceRequest } from "@tcpl-marketer/orchestration-contracts";

import { PasswordHasher } from "../dist/auth/password-hasher.js";
import { createApp } from "../dist/bootstrap.js";
import { initErrorReporting, flushErrorReporting } from "../dist/observability/error-reporting.js";
import { OpenAISearchAdapter } from "../dist/search/openai-search.adapter.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const databaseName = databaseUrl ? new URL(databaseUrl).pathname.slice(1) : "";
if (!/^tcpl_(ph|test)/.test(databaseName)) {
  throw new Error("Refusing to run: DATABASE_URL must name a disposable tcpl_ph* or tcpl_test* database");
}
const tickSecret = process.env.SERVICE_SECRET_N8N_OUTBOX_DISPATCH;
if (!tickSecret) throw new Error("SERVICE_SECRET_N8N_OUTBOX_DISPATCH is required");

const realSecrets = Object.entries(process.env)
  .filter(([name, value]) => (/^SERVICE_SECRET_/.test(name) || name === "N8N_SERVICE_SECRET") && (value ?? "").length >= 16)
  .map(([, value]) => value);

// Fresh fake secrets for this run. The shared marker lets the shell scan the log for them.
const marker = "GATEFAKE";
const fakeKey = `sk-proj-${marker}${randomBytes(12).toString("hex")}`;
const fakeBearer = `${marker}BEARER${randomBytes(12).toString("hex")}`;
const fakeSecrets = [fakeKey, fakeBearer];

process.env.OPENAI_API_KEY = "disabled-for-gate-run";
// Provider caps (PH1-03a): the app refuses to start with a provider key and no caps. These runs make no provider call.
for (const [name, value] of Object.entries({
  BUDGET_GLOBAL_DAY_USD: "5", BUDGET_OPENAI_RUN_USD: "2", BUDGET_OPENAI_CAMPAIGN_USD: "2", BUDGET_OPENAI_DAY_USD: "5",
  OPENAI_ESTIMATE_CALL_USD: "0.05", BUDGET_APOLLO_RUN_CREDITS: "10", BUDGET_APOLLO_CAMPAIGN_CREDITS: "10",
  BUDGET_APOLLO_DAY_CREDITS: "10", APOLLO_ESTIMATE_CALL_CREDITS: "1", APOLLO_USD_PER_CREDIT: "0.10",
})) process.env[name] ??= value;
process.env.OUTBOX_DISPATCH_ENABLED = "true";
process.env.OUTBOX_MAX_ATTEMPTS = "3";
process.env.N8N_BASE_URL = process.env.N8N_BASE_URL ?? "http://localhost:5678";

const port = 4000;
const api = `http://127.0.0.1:${port}`;
const database = createPrismaClient(databaseUrl);
const report = { database: databaseName, runId: randomUUID() };
const sentryEnvelopes = [];

function check(name, passed, detail) {
  report[name] = detail === undefined ? passed : { passed, detail };
  if (!passed) throw new Error(`Check failed: ${name} ${JSON.stringify(detail ?? "")}`);
}
const leaks = (text) => [...fakeSecrets, ...realSecrets].filter((secret) => text.includes(secret)).length;
const tickPath = "/internal/orchestration/dispatch";
const tickHeaders = (overrides = {}) =>
  signServiceRequest({
    keyId: "n8n-outbox-dispatch",
    secret: tickSecret,
    method: "POST",
    path: tickPath,
    requestId: `gate-${randomUUID()}`,
    ...overrides,
  });

async function n8nHistory(needles) {
  const script = `
    const { DatabaseSync } = require("node:sqlite");
    const database = new DatabaseSync("/home/node/.n8n/database.sqlite", { readOnly: true });
    const needles = JSON.parse(process.env.GATE_NEEDLES);
    const out = { executions: 0, matches: {} };
    for (const row of database.prepare("select executionId, data from execution_data").iterate()) {
      out.executions += 1;
      for (const needle of needles) if (String(row.data).includes(needle)) out.matches[needle] = (out.matches[needle] ?? 0) + 1;
    }
    console.log(JSON.stringify(out));`;
  const { stdout } = await promisify(execFile)(
    "docker",
    ["exec", "-e", "GATE_NEEDLES", "tcpl-marketer-n8n-1", "node", "--no-warnings", "-e", script],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, GATE_NEEDLES: JSON.stringify(needles), MSYS_NO_PATHCONV: "1" } },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

async function main() {
  initErrorReporting({
    dsn: "https://publickey@o0.ingest.sentry.io/0",
    environment: "gate",
    transport: () => ({
      send: (envelope) => {
        sentryEnvelopes.push(JSON.stringify(envelope));
        return Promise.resolve({ statusCode: 200 });
      },
      flush: () => Promise.resolve(true),
    }),
  });
  const app = await createApp();
  const adapter = app.get(OpenAISearchAdapter);
  let providerCalls = 0;
  adapter.plan = () => {
    providerCalls += 1;
    return Promise.reject(
      Object.assign(new Error(`Incorrect API key provided: ${fakeKey}. Authorization: Bearer ${fakeBearer}`), {
        headers: { authorization: `Bearer ${fakeBearer}` },
      }),
    );
  };
  adapter.search = () => {
    providerCalls += 1;
    return Promise.reject(new Error("search must not run after a failed plan"));
  };
  await app.listen(port);

  try {
    const email = `gate-${randomUUID()}@example.test`;
    const password = `${randomBytes(18).toString("base64url")}aA1!`;
    const role = await database.role.upsert({ where: { name: "MANAGER" }, create: { name: "MANAGER" }, update: {} });
    await database.user.create({
      data: { email, passwordHash: await new PasswordHasher().hash(password), roles: { create: { roleId: role.id } } },
    });
    const login = await fetch(`${api}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (login.status !== 200) throw new Error(`Login returned HTTP ${login.status}`);
    const cookie = (login.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    const authed = (path, method = "GET", body, extraHeaders = {}) =>
      fetch(api + path, {
        method,
        headers: { cookie, "content-type": "application/json", origin: "http://localhost:3000", ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    const lidar = await database.sector.findUniqueOrThrow({
      where: { slug: "lidar" },
      include: { capabilities: { include: { deliverables: true, targetProfiles: true } } },
    });
    const capability = lidar.capabilities[0];
    const created = await authed("/campaigns", "POST", {
      name: `PH1-02 gate ${report.runId.slice(0, 8)}`,
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
    const campaignId = (await created.json()).id;

    // 1. A start whose provider fails with an error that echoes secrets, through the real n8n.
    const correlationId = `gate-trace-${randomUUID().slice(0, 8)}`;
    const started = await authed(`/campaigns/${campaignId}/start`, "POST", undefined, { "x-correlation-id": correlationId });
    const startedText = await started.text();
    check("failureSurfacedToCaller", started.status >= 500, started.status);
    check("responseEchoesCorrelationId", started.headers.get("x-correlation-id") === correlationId && startedText.includes(correlationId));
    check("responseHoldsNoSecret", leaks(startedText) === 0);

    const event = await database.outboxEvent.findFirstOrThrow({ where: { aggregateId: campaignId } });
    check("outboxEventCarriesTrace", event.correlationId === correlationId && event.status === "PENDING" && event.attempts === 1, { status: event.status, attempts: event.attempts });
    const run = await database.stageRun.findFirstOrThrow({ where: { campaignId } });
    check("stageRunCarriesTrace", run.correlationId === correlationId && run.status === "PENDING" && run.lastError === "Discovery failed: Error", { status: run.status, lastError: run.lastError });
    const rows = await database.auditLog.findMany({ where: { campaignId, NOT: { action: "campaign.created" } }, orderBy: { createdAt: "asc" } });
    const actions = rows.map((row) => row.action);
    check("auditRowsOnOneTrace", rows.length >= 4 && rows.every((row) => row.correlationId === correlationId), actions);
    const providerRow = rows.find((row) => row.action === "provider.call");
    check("providerFailureAudited", providerRow?.metadata?.status === "FAILED" && providerRow.metadata.errorName === "Error", providerRow?.metadata);
    check("incidentTraceLinksCampaignToStage", actions.includes("campaign.start_requested") && actions.includes("stage.transitioned") && rows.some((row) => row.resourceId === run.id));
    check("durableRecordsHoldNoSecret", leaks(JSON.stringify({ event, run, rows })) === 0);
    check("providerCalledOnce", providerCalls === 1, providerCalls);

    // 2. The same trace is visible in Sentry's payload and in n8n, with no secret in either.
    await flushErrorReporting();
    const sentryText = sentryEnvelopes.join("\n");
    check("sentryReceivedTracedEvent", sentryEnvelopes.length > 0 && sentryText.includes(correlationId), sentryEnvelopes.length);
    check("sentryHoldsNoSecret", leaks(sentryText) === 0);
    const history = await n8nHistory([correlationId, marker, ...realSecrets]);
    check("n8nExecutionTracedByCorrelationId", (history.matches[correlationId] ?? 0) >= 1, history.matches[correlationId] ?? 0);
    check("n8nHistoryHoldsNoSecret", Object.keys(history.matches).filter((needle) => needle !== correlationId).length === 0, Object.keys(history.matches).length);

    // 3. One valid signed request, then a replay, a tampered body and a wrong-scope call.
    // Only this caller is counted: on a reused database, retried events can make other callers write nonces.
    const dispatchNonces = () => database.serviceRequestNonce.count({ where: { callerId: "n8n-outbox-dispatch" } });
    const nonceBefore = await dispatchNonces();
    const valid = tickHeaders();
    const accepted = await fetch(api + tickPath, { method: "POST", headers: valid });
    // The accepted tick may legitimately retry an earlier failed event on a reused database; the rejections must add no call.
    const callsAfterAccepted = providerCalls;
    const replayed = await fetch(api + tickPath, { method: "POST", headers: valid });
    const tampered = await fetch(api + tickPath, {
      method: "POST",
      headers: { ...tickHeaders({ body: '{"a":1}' }), "content-type": "application/json" },
      body: '{"a":2}',
    });
    const otherPath = `/internal/campaigns/${campaignId}/prepare-discovery`;
    const wrongScope = await fetch(api + otherPath, { method: "POST", headers: tickHeaders({ path: otherPath }) });
    check("oneSuccessThreeRejections", accepted.status === 200 && replayed.status === 401 && tampered.status === 401 && wrongScope.status === 403, [accepted.status, replayed.status, tampered.status, wrongScope.status]);
    check("rejectedCallsStoredNothing", (await dispatchNonces()) === nonceBefore + 1);
    check("noProviderCallFromRejections", providerCalls === callsAfterAccepted, { callsAfterAccepted, providerCalls });
    const rejections = await database.auditLog.findMany({ where: { action: "service_auth.rejected" } });
    check("rejectionsAudited", ["REPLAYED", "BAD_SIGNATURE", "WRONG_SCOPE"].every((reason) => rejections.some((row) => row.metadata.reason === reason)), rejections.map((row) => row.metadata.reason));
    check("rejectionsHoldNoSignatureOrSecret", !JSON.stringify(rejections).includes(valid["x-service-signature"]) && leaks(JSON.stringify(rejections)) === 0);
    report.result = "PASS";
  } finally {
    await app.close();
    await database.$disconnect();
  }
  console.log(JSON.stringify(report, null, 1));
}

main().catch((error) => {
  console.log(JSON.stringify(report, null, 1));
  console.error(error instanceof Error ? error.message : "Gate run failed");
  process.exit(1);
});
