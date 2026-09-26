# n8n workflows

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
3. Import `workflows/campaign-start.json`, attach that credential to the
   webhook, and publish the workflow.
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

## Company research

`company-research.json` is the Day 4 orchestration-only workflow. It accepts a
lead-candidate ID, signs and invokes
`POST /internal/lead-candidates/:id/research`, and returns the NestJS result
with the n8n execution ID. OpenAI calls, schema/evidence validation, claim
persistence, and the company-profile projection remain inside NestJS.

Import and publish it with the same `TCPL NestJS Service` Header Auth
credential used by `campaign-start.json`. With the API, PostgreSQL, and n8n
running, execute the controlled acceptance check:

```text
pnpm --filter @tcpl-marketer/api day4:evidence-live
```

The command creates and retains a labeled one-company acceptance fixture,
persists one public source through the safe crawler, invokes the published n8n
workflow twice, and verifies one real OpenAI extraction run plus cached repeat
behavior. Its output includes both n8n execution IDs, PostgreSQL counts, claim
statements, and source URLs for manual comparison.
