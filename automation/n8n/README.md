# n8n workflows

## Current boundary — Day 5

The existing campaign-start and company-research workflows are separate controlled slices, not the complete automatic campaign-to-BDE pipeline. PH1-01, PH1-07, PH1-09, PH1-20, PH2-12, PH2-17 and PH4-08 must prove durable progression, recovery and deployed-version parity. Business acceptance of qualification and people discovery is PH1-25 (Checkpoint 1). See [baseline audit](../../docs/planning/BASELINE_AUDIT_2026-10-05.md).

Inspect existing workflow ID/version/credentials before updating. Update an existing matching workflow in place; import only when absent. Do not disconnect/recreate credentials or add a duplicate just to repeat setup. Any browser automation attachment must be disconnected after verification.

## Existing discovery slice

`campaign-start.json` is the Day 3 orchestration workflow. It accepts a durable
`CAMPAIGN_STARTED` event, signs internal requests, asks NestJS for the campaign
context, and then asks NestJS to prepare discovery. Search planning, provider
calls, organization resolution, and persistence remain inside NestJS; n8n does
not read PostgreSQL or implement campaign rules.

Local setup:

1. Set strong, matching `N8N_SERVICE_SECRET` and `N8N_ENCRYPTION_KEY` values in
   the local `.env` file. Do not commit either value.
2. Start the API and n8n, then create an n8n Header Auth credential named
   `TCPL NestJS Service` with header `Authorization` and value
   `Bearer <N8N_SERVICE_SECRET>`.
3. Inspect whether the campaign-start workflow already exists. Update it in
   place when present; import `workflows/campaign-start.json` only when absent.
   Preserve/attach the matching credential and publish the intended version.
4. Ensure the API process has `OPENAI_API_KEY` and `OPENAI_RESEARCH_MODEL`.
5. Start a small DRAFT campaign through `POST /campaigns/:id/start` and inspect
   the n8n execution. Both HTTP Request nodes must succeed: context loading and
   discovery preparation. No node may access the application database or own
   business rules.
6. Confirm the webhook response includes `discovery.persistence` with stable
   organization and candidate IDs. Repeating the signed discovery request must
   return the same IDs rather than create duplicates.

For a controlled live closeout using the seeded LiDAR configuration and an
existing ADMIN or MANAGER account, run:

```text
pnpm --filter @tcpl-marketer/api day3:live
```

The command creates a small `MANUAL_REVIEW` campaign through the API, starts it
through n8n, verifies that several candidates were persisted, removes only its
temporary session, and prints the retained campaign and organization IDs for
independent inspection.

The outbound n8n call uses an HMAC-SHA256 signature over
`<timestamp>\n<method>\n<path>`. NestJS rejects stale or invalid signatures.

## Outbox dispatch tick

`outbox-dispatch.json` runs every minute, signs a request and calls `POST /internal/orchestration/dispatch`. NestJS decides what is due, retries, and records every outcome; the workflow holds no business logic.

**Keep this workflow inactive and `OUTBOX_DISPATCH_ENABLED=false` until PH1-03 adds provider spend caps.** Turning it on would retry any pending events, including two stuck September campaign starts in the dev database, which would make paid OpenAI calls (FND-027). Campaigns started by a user still dispatch immediately without this workflow.

To check it locally without spending, build the API and run `apps/api/test/n8n-dispatch-local-smoke.mjs` against a disposable database; the file header has the command.

## Company research

`company-research.json` is the controlled research-to-scoring-to-people-selection orchestration
workflow. It accepts a lead-candidate ID, signs and invokes
`POST /internal/lead-candidates/:id/research`, then signs and invokes
`POST /internal/lead-candidates/:id/score`. When NestJS reports that the lead is
qualified, n8n signs and invokes
`POST /internal/lead-candidates/:id/decision-makers`; otherwise it stops without
calling people providers. It returns the NestJS results with the n8n execution
ID. OpenAI calls, schema/evidence validation, claims, scoring and ranking rules,
provider decisions, candidate-state decisions, and persistence remain inside
NestJS.

The people-selection response records provider warnings instead of crashing the
campaign. It returns `COMPLETE` only when three unique current people with a
public profile or source URL fill the `PRIMARY`, `SECONDARY`, and `FALLBACK`
slots. Evidence-less candidates are excluded and reported in `warnings`. A
smaller result is persisted as `REVIEW_REQUIRED` with explicit `missingSlots`
and `warnings`. Every assignment returns its person and role source fields plus
a resolved `reviewUrl`. Review the latest persisted selection with the same
HMAC authentication at
`GET /internal/lead-candidates/:id/decision-makers`.

Current code assigns `companySizeFit = 0` to all candidates, not only the demo organization. This avoids inventing headcount but does not implement size-aware ranking; PH1-14 owns the size-aware ranking behavior (F002 supplied the verified-size evidence). The current three-slot COMPLETE rule is not proof of buying authority; PH1-13 and PH1-14 must verify relevance and allow explicit incomplete/review outcomes rather than force-fill slots.

On a fresh n8n installation only, import and publish this workflow with the
same `TCPL NestJS Service` Header Auth credential used by
`campaign-start.json`. When workflow `D014dCompanyResearch` already exists,
update that workflow in place and keep its existing credential and webhook;
do not import a duplicate. With the API, PostgreSQL, and n8n running, execute
the controlled research acceptance check:

```text
pnpm --filter @tcpl-marketer/api day4:evidence-live
```

The command creates and retains a labeled one-company acceptance fixture,
persists one public source through the safe crawler, invokes the published n8n
workflow twice, and verifies one real OpenAI extraction run plus cached repeat
behavior. Its output includes both n8n execution IDs, PostgreSQL counts, claim
statements, and source URLs for manual comparison.

F001 scoring inspection of an existing campaign and candidate (no provider call by default):

```powershell
$env:F001_CAMPAIGN_ID = "<existing-campaign-uuid>"
$env:F001_CANDIDATE_ID = "<candidate-uuid-in-that-campaign>"
pnpm --filter @tcpl-marketer/api day5:scoring-live
```

The output labels campaign weights, durable campaign/candidate/person provenance, observed people providers, latest persisted score/selection, and why the candidate is or is not eligible for an unseeded diagnostic run. It always reports business acceptance as `UNVERIFIED`. New campaigns/candidates/people created through the normal NestJS paths are labelled `APPLICATION`; known older acceptance records are labelled `ACCEPTANCE_FIXTURE`, and other legacy records remain `UNKNOWN` and fail closed. The former D015 command created a capability-only fixture; its old score is not business qualification.

F001 people inspection uses the same IDs and reads the same persisted provenance:

```powershell
pnpm --filter @tcpl-marketer/api day5:people-live
```

Neither runner inserts expected people, changes decision-maker profiles or role flags, or deletes canonical records. `F001_CLEANUP=1` is an explicit no-op; durable diagnostic audit records are retained. To call the live company-research workflow for an eligible candidate, set `F001_EXECUTE=1` and use the normal n8n service configuration. That call may use paid OpenAI research and People Search; it is a diagnostic of the selected candidate, not Gate A acceptance. A fixture/unknown campaign or candidate, capability-only weights, manually reviewed/fixture/unknown organization people, a missing stored research document, a stale candidate stage, or an existing diagnostic run blocks execution. The runner claims the candidate once in PostgreSQL before dispatch, forwards that claim through each protected NestJS stage, checks the input again, and reconciles the workflow response against the persisted score, candidate status, campaign and people provenance. An HTTP failure, timeout, partial response or changed state leaves a `NEEDS_REVIEW` diagnostic record. `F001_RECONCILE=1` is the supported no-provider reconciliation path: it verifies a persisted score/result against the durable diagnostic claim, or keeps the run in `NEEDS_REVIEW` with an explicit reason. The runner will not blindly retry the same candidate automatically. A successful technical reconciliation records `VERIFIED` but still reports business acceptance as `UNVERIFIED`. No runner replays the workflow for cache testing, because people discovery can call providers on every invocation.

Future workflow acceptance must begin through normal campaign start, keep business rules/persistence in NestJS, show published definition/version and run IDs, and require no manual intermediate webhook invocation. Never send to a real prospect without separate approval.
