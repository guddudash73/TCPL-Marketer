/* global AbortSignal, Buffer, console, fetch, process, URL */
/**
 * Local proof of the dispatcher through the real n8n container (PH1-01b, PH1-01).
 * Runs the compiled API with a disposable database and a stubbed search provider,
 * so it makes no paid call. It refuses any database not named tcpl_ph* or tcpl_test*.
 *
 * Run from apps/api after building, with the API port free:
 *   DATABASE_URL=<throwaway> node --env-file-if-exists=../../.env test/n8n-dispatch-local-smoke.mjs
 */
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { promisify } from "node:util";

import { createPrismaClient } from "@tcpl-marketer/database";
import { createN8nWebhookToken, signServiceRequest } from "@tcpl-marketer/orchestration-contracts";

import { PasswordHasher } from "../dist/auth/password-hasher.js";
import { createApp } from "../dist/bootstrap.js";
import { OutboxDispatcherService } from "../dist/orchestration/outbox-dispatcher.service.js";
import { OpenAISearchAdapter } from "../dist/search/openai-search.adapter.js";

const databaseUrl = process.env.DATABASE_URL ?? "";
const databaseName = databaseUrl ? new URL(databaseUrl).pathname.slice(1) : "";
if (!/^tcpl_(ph|test)/.test(databaseName)) {
  throw new Error("Refusing to run: DATABASE_URL must name a disposable tcpl_ph* or tcpl_test* database");
}
const tickSecret = process.env.SERVICE_SECRET_N8N_OUTBOX_DISPATCH;
if (!tickSecret) throw new Error("SERVICE_SECRET_N8N_OUTBOX_DISPATCH is required");

process.env.OPENAI_API_KEY = "disabled-for-local-smoke";
process.env.OUTBOX_DISPATCH_ENABLED = "true";
process.env.OUTBOX_MAX_ATTEMPTS = "3";
process.env.N8N_BASE_URL = process.env.N8N_BASE_URL ?? "http://localhost:5678";

const port = 4000;
const api = `http://127.0.0.1:${port}`;
const database = createPrismaClient(databaseUrl);
const report = { database: databaseName };

function check(name, passed, detail) {
  report[name] = detail === undefined ? passed : { passed, detail };
  if (!passed) throw new Error(`Check failed: ${name} ${JSON.stringify(detail ?? "")}`);
}

const tickPath = "/internal/orchestration/dispatch";
const tickHeaders = (overrides = {}) =>
  signServiceRequest({
    keyId: "n8n-outbox-dispatch",
    secret: tickSecret,
    method: "POST",
    path: tickPath,
    requestId: `smoke-${randomUUID()}`,
    ...overrides,
  });

async function signedTick() {
  const response = await fetch(api + tickPath, { method: "POST", headers: tickHeaders() });
  if (!response.ok) throw new Error(`Tick returned HTTP ${response.status}`);
  return response.json();
}

async function main() {
  const app = await createApp();
  const adapter = app.get(OpenAISearchAdapter);
  let planCalls = 0;
  let searchCalls = 0;
  adapter.plan = () => {
    planCalls += 1;
    return Promise.resolve({
      data: { strategies: [{ type: "DIRECT_COMPANY", queries: ["Canada LiDAR survey companies"] }] },
      model: "stub",
      providerResponseId: "stub-plan",
      prompt: { name: "campaign-search-plan", version: "v1" },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
  };
  adapter.search = () => {
    searchCalls += 1;
    const suffix = randomUUID().slice(0, 8);
    return Promise.resolve({
      data: [
        {
          organizationName: `Smoke Survey ${suffix} Inc.`,
          organizationLocation: "Calgary, Alberta, Canada",
          websiteUrl: `https://smoke-${suffix}.example/services`,
          sourceUrl: `https://evidence.example/smoke-${suffix}`,
          sourceTitle: "Stubbed result",
          summary: "Stubbed organization for a local dispatcher smoke test.",
          evidenceSnippet: "Stubbed evidence.",
          strategyType: "DIRECT_COMPANY",
          query: "Canada LiDAR survey companies",
        },
      ],
      model: "stub",
      providerResponseId: "stub-search",
      prompt: { name: "campaign-search-discovery", version: "v1" },
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    });
  };
  await app.listen(port);

  try {
    const email = `smoke-${randomUUID()}@example.test`;
    const password = `${randomBytes(18).toString("base64url")}aA1!`;
    const role = await database.role.upsert({
      where: { name: "MANAGER" },
      create: { name: "MANAGER" },
      update: {},
    });
    await database.user.create({
      data: {
        email,
        passwordHash: await new PasswordHasher().hash(password),
        roles: { create: { roleId: role.id } },
      },
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
    const newCampaign = async (name) => {
      const response = await authed("/campaigns", "POST", {
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
      if (response.status !== 201) {
        throw new Error(`Create campaign returned HTTP ${response.status}: ${await response.text()}`);
      }
      return (await response.json()).id;
    };

    // 1. Normal start through the supported API and the real n8n workflow.
    const first = await newCampaign("Smoke normal start");
    const traceId = `smoke-trace-${randomUUID().slice(0, 8)}`;
    const started = await authed(`/campaigns/${first}/start`, "POST", undefined, { "x-correlation-id": traceId });
    check("normalStartHttp201", started.status === 201, started.status);
    check("startEchoesCorrelationId", started.headers.get("x-correlation-id") === traceId);
    const firstEvent = await database.outboxEvent.findUniqueOrThrow({
      where: { idempotencyKey: `campaign-start:${first}` },
      include: { automationRun: true },
    });
    check("normalEventPublished", firstEvent.status === "PUBLISHED" && firstEvent.attempts === 1, firstEvent.status);
    check("realN8nExecutionId", Boolean(firstEvent.automationRun?.externalRunId), firstEvent.automationRun?.externalRunId);
    const firstRun = await database.stageRun.findFirstOrThrow({ where: { campaignId: first } });
    check("discoveryStageSucceeded", firstRun.status === "SUCCEEDED" && firstRun.attempt === 1, firstRun.status);
    check("providerCalledOnce", planCalls === 1 && searchCalls === 1, { planCalls, searchCalls });
    // The stage run was created by the request n8n made, so this proves the workflow forwarded the header.
    check("n8nForwardedCorrelationId", firstRun.correlationId === traceId, firstRun.correlationId);
    // campaign.created belongs to an earlier request, so it has its own trace.
    const traced = await database.auditLog.findMany({
      where: { campaignId: first, NOT: { action: "campaign.created" } },
    });
    check(
      "auditRowsShareOneTrace",
      traced.length >= 7 && traced.every((row) => row.correlationId === traceId),
      traced.map((row) => row.action),
    );

    // 2. The API "dies" after n8n accepted the event and before it is recorded.
    const second = await newCampaign("Smoke crash after publish");
    const dispatcher = app.get(OutboxDispatcherService);
    const originalAcknowledge = dispatcher.acknowledge;
    dispatcher.acknowledge = () => {
      dispatcher.acknowledge = originalAcknowledge;
      return Promise.reject(new Error("simulated crash after publish"));
    };
    const crashed = await authed(`/campaigns/${second}/start`, "POST");
    check("crashSurfacedAsError", crashed.status === 500, crashed.status);
    const stuck = await database.outboxEvent.findUniqueOrThrow({
      where: { idempotencyKey: `campaign-start:${second}` },
    });
    check("eventLeftProcessing", stuck.status === "PROCESSING" && stuck.attempts === 1, stuck.status);
    const candidatesAfterCrash = await database.leadCandidate.count({ where: { campaignId: second } });
    check("firstDeliveryDidTheWork", candidatesAfterCrash === 1 && searchCalls === 2, { candidatesAfterCrash, searchCalls });

    await database.$executeRawUnsafe(
      `UPDATE outbox_events SET lease_expires_at = now() - interval '5 seconds' WHERE id = $1::uuid`,
      stuck.id,
    );
    const recovery = await signedTick();
    check("tickRecoveredEvent", recovery.reclaimedEvents === 1 && recovery.published === 1, recovery);
    const recovered = await database.outboxEvent.findUniqueOrThrow({
      where: { id: stuck.id },
      include: { automationRun: true },
    });
    check("eventPublishedAfterReplay", recovered.status === "PUBLISHED" && recovered.attempts === 2, recovered.status);
    check("realN8nRanReplay", Boolean(recovered.automationRun?.externalRunId), recovered.automationRun?.externalRunId);
    check("noExtraProviderCall", planCalls === 2 && searchCalls === 2, { planCalls, searchCalls });
    check(
      "noDuplicateCandidates",
      (await database.leadCandidate.count({ where: { campaignId: second } })) === candidatesAfterCrash,
    );
    const replayRuns = await database.stageRun.findMany({ where: { campaignId: second } });
    check("oneStageRun", replayRuns.length === 1 && replayRuns[0]?.attempt === 1, replayRuns.length);
    check(
      "campaignRunning",
      (await database.campaign.findUniqueOrThrow({ where: { id: second } })).status === "RUNNING",
    );

    // 3. A permanently failing event becomes a visible dead letter.
    const third = await newCampaign("Smoke dead letter");
    await database.campaign.update({ where: { id: third }, data: { status: "RUNNING" } });
    const poison = await database.outboxEvent.create({
      data: {
        eventType: "CRAWL_COMPLETED",
        aggregateType: "campaign",
        aggregateId: third,
        idempotencyKey: `smoke-poison:${third}`,
        payload: { campaignId: third },
        availableAt: new Date(0),
      },
    });
    const poisonTick = await signedTick();
    check("poisonDeadLettered", poisonTick.deadLettered === 1, poisonTick);
    const letters = await (await authed("/orchestration/dead-letters")).json();
    const letter = letters.find((item) => item.id === poison.id);
    check("deadLetterVisible", Boolean(letter?.lastError.includes("No orchestration route")), letter?.lastError);

    // 4. The live verifier: one success, then replay, tamper and wrong scope all fail with no effect.
    const liveHeaders = tickHeaders();
    const accepted = await fetch(api + tickPath, { method: "POST", headers: liveHeaders });
    check("signedRequestAccepted", accepted.status === 200, accepted.status);
    const nonceCount = await database.serviceRequestNonce.count();
    const replayed = await fetch(api + tickPath, { method: "POST", headers: liveHeaders });
    check("replayRejected", replayed.status === 401, replayed.status);
    const tampered = await fetch(api + tickPath, {
      method: "POST",
      headers: { ...tickHeaders({ body: '{"a":1}' }), "content-type": "application/json" },
      body: '{"a":2}',
    });
    check("tamperedBodyRejected", tampered.status === 401, tampered.status);
    const otherPath = `/internal/campaigns/${first}/prepare-discovery`;
    const wrongScope = await fetch(api + otherPath, {
      method: "POST",
      headers: tickHeaders({ path: otherPath }),
    });
    check("wrongScopeRejected", wrongScope.status === 403, wrongScope.status);
    check("rejectionsStoredNoNonce", (await database.serviceRequestNonce.count()) === nonceCount);
    const rejections = await database.auditLog.findMany({ where: { action: "service_auth.rejected" } });
    const reasons = rejections.map((row) => row.metadata.reason);
    check(
      "rejectionsAudited",
      ["REPLAYED", "BAD_SIGNATURE", "WRONG_SCOPE"].every((reason) => reasons.includes(reason)),
      reasons,
    );
    const auditText = JSON.stringify(rejections);
    check(
      "noSignatureOrSecretInAudit",
      !auditText.includes(liveHeaders["x-service-signature"]) && !auditText.includes(tickSecret),
    );

    // The research workflow signs for the real verifier. An unknown candidate stops before any provider
    // call; a stored nonce proves the guard accepted n8n's signature.
    const researchNoncesBefore = await database.serviceRequestNonce.count({ where: { callerId: "n8n-company-research" } });
    const webhookCall = (authorization) =>
      fetch(`${process.env.N8N_BASE_URL}/webhook/company-research`, {
        method: "POST",
        headers: { ...(authorization ? { authorization } : {}), "content-type": "application/json" },
        body: JSON.stringify({ candidateId: randomUUID() }),
        signal: AbortSignal.timeout(30_000),
      });
    const webhookSecret = process.env.N8N_SERVICE_SECRET;
    const issue = (secret, options = {}) => createN8nWebhookToken(secret, { subject: "company-research", ...options });
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const now = Math.floor(Date.now() / 1_000);
    const unsignedToken = `${encode({ alg: "none", typ: "JWT" })}.${encode({ sub: "company-research", iat: now, exp: now + 60 })}.`;
    const refused = {
      noToken: (await webhookCall()).status,
      rawSecret: (await webhookCall(`Bearer ${webhookSecret}`)).status,
      expiredToken: (await webhookCall(`Bearer ${issue(webhookSecret, { now: Date.now() - 120_000 })}`)).status,
      wrongKey: (await webhookCall(`Bearer ${issue("a-different-signing-key-0123456789abcdef")}`)).status,
      unsignedToken: (await webhookCall(`Bearer ${unsignedToken}`)).status,
    };
    check("webhookRefusesBadTokens", Object.values(refused).every((status) => status === 401 || status === 403), refused);
    check(
      "refusedWebhookCallsReachedNoEndpoint",
      (await database.serviceRequestNonce.count({ where: { callerId: "n8n-company-research" } })) === researchNoncesBefore,
    );
    await webhookCall(`Bearer ${issue(webhookSecret)}`);
    const researchNoncesAfter = await database.serviceRequestNonce.count({ where: { callerId: "n8n-company-research" } });
    check("researchWorkflowAccepted", researchNoncesAfter === researchNoncesBefore + 1, { researchNoncesBefore, researchNoncesAfter });

    // 5. Optional: the tick nodes executed once by n8n. n8n cannot start a schedule
    // trigger from its CLI, so import a copy with a manual trigger first.
    if (process.env.SMOKE_N8N_TICK_WORKFLOW === "1") {
      // Must not block: this process is also the API that n8n calls back.
      const { stdout: output } = await promisify(execFile)(
        "docker",
        ["exec", "-e", "N8N_RUNNERS_BROKER_PORT=5699", "tcpl-marketer-n8n-1", "n8n", "execute", "--id=PH101bOutboxDispatch", "--rawOutput"],
        { encoding: "utf8", timeout: 90_000 },
      );
      check("tickWorkflowRan", output.includes("enabled"), output.length);
    }
    report.result = "PASS";
  } finally {
    await app.close();
    await database.$disconnect();
  }
  console.log(JSON.stringify(report, null, 1));
}

main().catch((error) => {
  console.log(JSON.stringify(report, null, 1));
  console.error(error instanceof Error ? error.message : "Smoke test failed");
  process.exit(1);
});
