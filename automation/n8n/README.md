# n8n campaign-start workflow

`campaign-start.json` is the D010 orchestration workflow. It accepts a durable
`CAMPAIGN_STARTED` event, signs the internal request, and asks NestJS for the
campaign context. It does not read PostgreSQL or implement campaign rules.

Local setup:

1. Set strong, matching `N8N_SERVICE_SECRET` and `N8N_ENCRYPTION_KEY` values in
   the local `.env` file. Do not commit either value.
2. Start the API and n8n, then create an n8n Header Auth credential named
   `TCPL NestJS Service` with header `Authorization` and value
   `Bearer <N8N_SERVICE_SECRET>`.
3. Import `workflows/campaign-start.json`, attach that credential to the
   webhook, and publish the workflow.
4. Start a DRAFT campaign through `POST /campaigns/:id/start` and inspect the
   n8n execution. The HTTP Request node must call NestJS; no node may access the
   application database or own business rules.

The outbound n8n call uses an HMAC-SHA256 signature over
`<timestamp>\n<method>\n<path>`. NestJS rejects stale or invalid signatures.
