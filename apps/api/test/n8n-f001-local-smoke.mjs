/* global AbortSignal, Buffer, console, fetch, process */
// Opt-in local transport check. This mock API never calls providers or writes business data.
import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

import {
  EMPTY_BODY_SHA256,
  computeServiceSignature,
  createN8nWebhookToken,
  isValidServiceRequestId,
} from "@tcpl-marketer/orchestration-contracts";

const secret = process.env.N8N_SERVICE_SECRET;
if (!secret) throw new Error("N8N_SERVICE_SECRET is required");
const signingSecret = process.env.SERVICE_SECRET_N8N_COMPANY_RESEARCH;
if (!signingSecret) throw new Error("SERVICE_SECRET_N8N_COMPANY_RESEARCH is required");
const candidateId = randomUUID();
const diagnosticRunId = randomUUID();
const inputHash = "a".repeat(64);
const calls = [];
const responses = [
  { candidate: { id: candidateId }, profile: { organization: { id: randomUUID() } } },
  {
    id: randomUUID(), leadCandidateId: candidateId, candidateStatus: "QUALIFIED",
    cached: false, result: { qualified: true, grade: "A", recommendedAction: "STANDARD_REVIEW" },
  },
  { status: "REVIEW_REQUIRED", leadCandidateId: candidateId },
];
const routes = ["research", "score", "decision-makers"]
  .map((stage) => `/internal/lead-candidates/${candidateId}/${stage}`);

const seenRequestIds = new Set();
const echoedTraceId = `f001-trace-${randomUUID().slice(0, 8)}`;

const server = createServer((request, response) => {
  const routeIndex = routes.indexOf(request.url ?? "");
  const timestamp = request.headers["x-service-timestamp"];
  const signature = request.headers["x-service-signature"];
  const requestId = request.headers["x-service-request-id"];
  const keyId = request.headers["x-service-key-id"];
  const expected = typeof timestamp === "string" && typeof requestId === "string"
    ? computeServiceSignature(signingSecret, {
      keyId: "n8n-company-research", timestamp, requestId, method: "POST", path: request.url ?? "",
      bodySha256: EMPTY_BODY_SHA256, diagnosticRunId, inputHash,
    })
    : "";
  const noBody = !request.headers["transfer-encoding"]
    && ["0", undefined].includes(request.headers["content-length"]);
  const validSignature = typeof signature === "string" && signature.length === expected.length
    && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  const valid = request.method === "POST"
    && routeIndex === calls.length
    && typeof timestamp === "string"
    && Math.abs(Date.now() - Number(timestamp)) < 300_000
    && validSignature
    && keyId === "n8n-company-research"
    && isValidServiceRequestId(requestId)
    && !seenRequestIds.has(requestId)
    && noBody
    && request.headers["x-f001-diagnostic-run-id"] === diagnosticRunId
    && request.headers["x-f001-input-hash"] === inputHash;
  response.setHeader("content-type", "application/json");
  if (!valid) {
    response.writeHead(409);
    response.end(JSON.stringify({ error: "F001 transport mismatch" }));
    return;
  }
  seenRequestIds.add(requestId);
  calls.push(request.url);
  response.writeHead(200);
  response.end(JSON.stringify(responses[routeIndex]));
});

try {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(4000, "0.0.0.0", resolve);
  });
  const response = await fetch("http://localhost:5678/webhook/company-research", {
    method: "POST",
    headers: { "x-correlation-id": echoedTraceId, authorization: `Bearer ${createN8nWebhookToken(secret, { subject: "company-research" })}`, "content-type": "application/json" },
    body: JSON.stringify({ candidateId, diagnosticRunId, inputHash }),
    signal: AbortSignal.timeout(30_000),
  });
  const body = await response.text();
  if (!response.ok || calls.length !== 3) {
    throw new Error(`n8n transport smoke failed: HTTP ${response.status}; stages ${calls.length}; response ${body.slice(0, 300)}`);
  }
  if (response.headers.get("x-correlation-id") !== echoedTraceId) {
    throw new Error("n8n did not send the correlation ID back on the webhook reply");
  }
  const parsed = JSON.parse(body);
  if (!parsed.executionId || parsed.scoring?.leadCandidateId !== candidateId) {
    throw new Error("n8n response did not match the mocked candidate");
  }
  console.log(JSON.stringify({
    outcome: "PASS", executionId: parsed.executionId, replyEchoedCorrelationId: true,
    stages: ["research", "score", "decision-makers"],
    backend: "mock NestJS HTTP server; no database or provider calls",
  }));
} finally {
  await new Promise((resolve) => server.close(resolve));
}
