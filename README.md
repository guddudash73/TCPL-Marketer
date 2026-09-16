# TCPL Marketer

TCPL Marketer is a full-stack lead generation, company research, qualification, outreach, and sales workflow platform.

The platform helps sales teams move from campaign configuration to qualified opportunities by combining structured company research, configurable scoring, contact discovery, personalized outreach, reply processing, and BDE handoff in one system.

> This repository contains the application source code and technical implementation for TCPL Marketer.

---

## Features

- Sector and capability configuration
- Campaign creation and lifecycle management
- Company discovery and deduplication
- Public website crawling and company research
- Evidence-backed company intelligence
- Buying-signal and opportunity scoring
- Decision-maker discovery and ranking
- Business email enrichment and validation
- Personalized outreach generation
- Manual approval workflows
- Gmail-based email delivery and thread tracking
- Follow-up scheduling and automation
- Near-real-time reply detection
- Automatic follow-up cancellation on reply
- BDE assignment and lead handoff
- Sales pipeline, tasks, and notes
- Dashboard and campaign analytics
- Audit logging and operational observability

---

## Architecture

TCPL Marketer follows a modular monorepo architecture.

```text
Users
  │
  ▼
Next.js Web Application
  │
  ▼
NestJS API
  │
  ├── PostgreSQL
  ├── OpenAI
  ├── Apollo
  ├── Gmail API
  ├── AWS S3
  │
  └── n8n
        │
        └── Workflow orchestration
```

### Architectural Principle

The application keeps business logic and canonical application state in the backend and database.

```text
n8n
  ↓
NestJS API
  ↓
Domain / Application Services
  ↓
PostgreSQL / External Providers
```

n8n is used for orchestration and scheduling, while the NestJS application owns business rules, validation, provider interaction, scoring, state transitions, and safety checks.

---

## Technology Stack

### Frontend

- Next.js
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- TanStack Query
- TanStack Table
- Recharts

### Backend

- Node.js
- NestJS
- TypeScript
- Prisma
- Pino
- Swagger / OpenAPI

### Database

- PostgreSQL

### Automation

- n8n

### Research and Integrations

- OpenAI API
- Apollo API
- Gmail API
- Google Cloud Pub/Sub
- AWS S3

### Infrastructure

- Docker
- Docker Compose
- AWS
- GitHub Actions

### Observability

- Pino
- Sentry
- CloudWatch

---

## Repository Structure

```text
.
├── apps/
│   ├── web/                     # Next.js frontend
│   └── api/                     # NestJS backend
│
├── packages/
│   ├── database/                # Prisma schema and database utilities
│   ├── ui/                      # Shared UI components
│   ├── types/                   # Shared TypeScript types
│   ├── validation/              # Shared validation contracts
│   ├── config/                  # Shared configuration
│   ├── ai-contracts/            # Structured AI contracts
│   ├── provider-contracts/      # External provider interfaces
│   └── orchestration-contracts/ # Workflow/orchestration contracts
│
├── automation/
│   └── n8n/
│       └── workflows/
│
├── infrastructure/
│   ├── docker/
│   ├── nginx/
│   ├── deployment/
│   └── scripts/
│
├── docs/
├── docker-compose.yml
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

---

## Prerequisites

Install the following before running the project locally:

- Node.js
- pnpm
- Docker Desktop
- Git

Optional development tools:

- PostgreSQL client
- Postman or Bruno
- VS Code

Check your installed versions:

```bash
node --version
pnpm --version
docker --version
docker compose version
git --version
```

---

## Getting Started

### 1. Clone the repository

```bash
git clone <repository-url>
cd tcpl-marketer
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Configure environment variables

Copy the example environment file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Update the required local values.

Never commit real credentials or secrets.

### 4. Start local infrastructure

```bash
docker compose up -d
```

Typical local services include:

- PostgreSQL
- n8n

### 5. Prepare the database

Run the database scripts defined by the repository:

```bash
pnpm db:generate
pnpm db:migrate
```

If seed data is available:

```bash
pnpm db:seed
```

### 6. Start development

```bash
pnpm dev
```

---

## Local Services

Default local addresses:

| Service | URL |
|---|---|
| Web Application | `http://localhost:3000` |
| API | `http://localhost:4000` |
| n8n | `http://localhost:5678` |
| PostgreSQL | `localhost:5432` |

Ports may be changed through environment configuration.

---

## Environment Variables

The exact variables are documented in `.env.example`.

Typical configuration categories include:

```text
DATABASE_URL

WEB_URL
API_URL

AUTH_SECRET
TOKEN_ENCRYPTION_KEY

OPENAI_API_KEY
APOLLO_API_KEY

GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
GMAIL_PUBSUB_TOPIC
GOOGLE_CLOUD_PROJECT_ID

AWS_REGION
AWS_S3_BUCKET

N8N_BASE_URL
N8N_SERVICE_SECRET

SENTRY_DSN
```

Do not commit:

- API keys
- passwords
- OAuth access or refresh tokens
- private keys
- production credentials

---

## Common Commands

```bash
pnpm dev
pnpm build
pnpm lint
pnpm typecheck
pnpm test
```

Database commands may include:

```bash
pnpm db:generate
pnpm db:migrate
pnpm db:seed
pnpm db:studio
```

Docker:

```bash
docker compose up -d
docker compose down
docker compose logs -f
```

> Check `package.json` for the exact scripts available in the current repository.

---

## Development Workflow

A typical local development flow is:

```text
Install dependencies
        ↓
Start Docker services
        ↓
Run database migrations
        ↓
Start web + API
        ↓
Develop
        ↓
Lint / Type-check
        ↓
Test
        ↓
Build
```

Before opening a pull request, verify:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

---

## API Documentation

The backend exposes OpenAPI / Swagger documentation when enabled.

Typical development endpoint:

```text
http://localhost:4000/api/docs
```

Refer to the API configuration in `apps/api` for the exact route.

---

## Provider Design

External integrations are isolated behind application/provider boundaries where appropriate.

Examples include:

```text
SearchProvider
PeopleProvider
OrchestrationGateway
```

This keeps core business logic independent from a specific external provider and makes integrations easier to test, replace, and maintain.

---

## Research and Evidence

Company intelligence is designed around stored source evidence.

Material facts used for lead qualification or outreach should be traceable to their source rather than relying only on generated text.

The platform stores and processes information such as:

- company sources
- website documents
- claims
- buying signals
- company intelligence
- contact information
- outreach activity
- reply events

---

## Email Safety

Outbound communication is protected by application-level checks such as:

- campaign state validation
- contact status validation
- suppression checks
- send limits
- reply state checks
- sequence state checks
- idempotency

When a valid reply is received, future follow-ups are cancelled before reply classification continues.

Development and testing should use controlled test accounts and recipients.

---

## Security

The application is designed with the following security controls:

- Role-based access control
- Secure authentication
- Service-to-service authentication
- Input validation
- Rate limiting
- Secret management
- OAuth token protection
- Audit logging
- SSRF protection for web crawling
- Prompt-injection safeguards
- Structured output validation
- Least-privilege infrastructure access

Do not expose internal automation or database services directly to the public internet.

---

## Testing

The project supports multiple layers of testing:

- Unit tests
- Integration tests
- Provider integration tests
- AI contract tests
- End-to-end tests
- Controlled production-pilot validation

Critical workflow behavior should be covered by deterministic automated tests wherever possible.

---

## Deployment

The application is designed to support separate environments:

```text
Development
Staging
Production
```

A typical production architecture includes:

```text
DNS / CDN
    ↓
Reverse Proxy
    ↓
Web / API / Automation
    ↓
PostgreSQL / S3 / External Providers
```

Production deployments should use:

- managed PostgreSQL
- secure secret storage
- HTTPS
- automated backups
- restricted automation administration
- monitoring and alerting

---

## CI/CD

The repository is intended to use GitHub Actions for continuous integration and deployment.

Typical pull-request validation:

```text
Install
  ↓
Lint
  ↓
Type-check
  ↓
Database validation
  ↓
Unit / Integration tests
  ↓
Build
```

Release flow may include:

```text
Docker build
  ↓
Security checks
  ↓
Deploy staging
  ↓
Smoke tests
  ↓
Promote production
```

---

## Contributing

When contributing:

1. Create a focused branch.
2. Keep changes scoped to one feature or fix.
3. Add or update tests.
4. Run the required validation locally.
5. Open a pull request with a clear description.
6. Do not commit secrets or local environment files.

Example:

```bash
git checkout -b feature/campaign-management
```

---

## Project Status

TCPL Marketer is under active development.

Features and project structure may evolve as the platform progresses through development, staging, pilot validation, and production hardening.

---

## License

Copyright © TCPL.

All rights reserved.

Unless a separate license file states otherwise, this repository and its contents are proprietary and may not be copied, distributed, modified, or used outside the organization without authorization.
