# TCPL Marketer

Lead generation and sales automation platform under development. **The full end-to-end V1 is not yet implemented or production-approved.**

## Current boundary (Day 5 audit)

Existing foundations include authentication/configuration, campaign creation/start, company discovery and normalization, protected website crawling, source-backed extraction, scoring, public/Apollo people adapters and persisted selection. D015/D016 business acceptance is reopened REVIEW: fixture runs do not prove fresh campaign qualification and people discovery.

Remaining tracked work includes autonomous stage progression/recovery, complete contact/suppression/outreach, Gmail/follow-ups/reply-stop, BDE/CRM, full operator UI, metrics and production infrastructure. See [baseline audit](docs/planning/BASELINE_AUDIT_2026-10-05.md), not a feature list presented as already shipped.

## Delivery controls

- [Product specification](PROJECT_PLAN.md)
- [Dated roadmap and capacity warning](DELIVERY_ROADMAP.md): pilot target Day 11; production target Day 18, conditional on evidence and approval
- [Tracker](project_tasks.csv) and [bounded task details](docs/planning/TASK_DETAILS.md)
- [Requirement ownership](docs/planning/V1_REQUIREMENTS_COVERAGE.md) and [quality gates](QUALITY_GATES.md)
- [Setup](SETUP.md), [accounts](ENVIRONMENT_SETUP.md), [manual V1 walkthrough](DEMO_SCRIPT.md)

## Architecture

Next.js UI → NestJS domain/API → PostgreSQL and replaceable provider adapters. n8n schedules/coordinates protected API calls; it does not own rules, prompts or canonical data. Redis/BullMQ workers remain future V2 replacement, not a current runtime dependency.

Source roots: `apps/web`, `apps/api`, `packages/database`, shared contract/validation packages, `automation/n8n/workflows`. New deployment and evidence artifacts live under `infrastructure` and `docs` as their tasks implement them.

## Local development

Use exact approved versions in STACK_VERSIONS.md, currently Node 24.21.0 and pnpm 12.4.2. From repository root:

```powershell
pnpm install --frozen-lockfile
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
docker compose up -d
pnpm --filter @tcpl-marketer/database generate
pnpm --filter @tcpl-marketer/database migrate:deploy
pnpm --filter @tcpl-marketer/database seed:configuration
```

Inspect the target database before migration/seed; never point these at production casually. Preserve existing .env values and never commit credentials. Seed is configuration, not evidence of live qualification.

Run API and web in separate terminals:

```powershell
pnpm --filter @tcpl-marketer/api dev
```

```powershell
pnpm dev
```

Root `pnpm dev` starts the web app only. Default endpoints: web localhost:3000, API localhost:4000, n8n localhost:5678, PostgreSQL localhost:5432. Start Docker before API. Bootstrap admin uses the existing `pnpm --filter @tcpl-marketer/api seed:admin` script and configured local credentials; inspect its prerequisites first.

## Checks

```powershell
pnpm lint
pnpm typecheck
pnpm --filter @tcpl-marketer/database validate
pnpm test
pnpm build
```

Select at most five focused checks for each task rather than rerunning everything reflexively. Future release acceptance also needs live controlled integration and browser/race/recovery evidence. These commands have not been rerun by the planning-only rebaseline.

Planning consistency check:

```powershell
node infrastructure/scripts/validate-project-plan.mjs
```

## Integration and safety

Read [n8n setup](automation/n8n/README.md) before touching existing workflows. Inspect current workflow identity/version and update the existing definition; do not blindly create duplicate imports.

Day3/day4/day5 live scripts can spend provider credits or mutate fixtures. Inspect first. D015/D016 runner outputs are historical component evidence, not full business acceptance.

Required email policy in development/rehearsal is TEST_OVERRIDE with a controlled internal mailbox and MANUAL_REVIEW. The complete enforcement still requires E/I task implementation and verification; environment values alone are not proof of safety. Never send real-prospect email or deploy without explicit authorization.

Keep credentials/OAuth tokens outside Git and logs; protect internal endpoints, n8n editor and database. Material claims need stored evidence. Reply handling must cancel follow-ups before AI classification.

## Source control

Preserve existing work. Use `codex/` prefix for requested branches; do not commit/push without authorization. Some project controls are locally ignored: inspect `git check-ignore` and reconcile required release files deliberately. Historical framework instructions in apps/web remain intact.

## License

Copyright © TCPL. All rights reserved.

Unless a separate license file states otherwise, this repository and its contents are proprietary and may not be copied, distributed, modified, or used outside the organization without authorization.

