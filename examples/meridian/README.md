# Meridian

Meridian is a spend-management platform for growing companies: expense
submission and approval, receipt capture, reimbursements, vendor invoices,
and finance/audit reporting — organized by organization, team, and role
(admin, manager, member, auditor).

## Architecture

Meridian is split into two services that together back a single-page web
app:

- **`graphql-gateway/`** — an Apollo Server (v4) GraphQL API that the SPA
  talks to directly. It authenticates end users via JWT, shapes the public
  schema, and delegates persistence and business rules to the internal
  Rails API.
- **`rails-api/`** — the internal REST API and system of record: Postgres
  models for organizations, teams, users, expenses, approvals,
  reimbursements, invoices, and reports.
- **`services/reconciliation-worker.js`** — a background job that polls
  pending reimbursements and reconciles them against bank acknowledgement
  status.

The gateway and Rails API communicate over an internal HTTP link; every
request from the gateway carries the authenticated user's id so Rails can
apply role- and ownership-based authorization consistently.

```
Web SPA ──GraphQL──▶ graphql-gateway ──REST──▶ rails-api ──▶ Postgres
                                                    ▲
                                    reconciliation-worker
```

## Local development

```bash
docker compose up --build
```

This brings up Postgres, Redis, the Rails API (`:3000`), the GraphQL
gateway (`:4000/graphql`), and the reconciliation worker.

To run the gateway standalone:

```bash
cd graphql-gateway
npm install
npm run dev
```

## Environment variables

| Variable | Used by | Purpose |
|---|---|---|
| `DATABASE_URL` | gateway, rails-api | Postgres connection string |
| `RAILS_API_URL` | gateway, worker | Base URL of the internal Rails API |
| `JWT_SECRET` | gateway | Signing secret for end-user session tokens |
| `INTERNAL_SECRET` | gateway, rails-api, worker | Shared secret for gateway → Rails service calls |
| `RECONCILE_INTERVAL_MS` | worker | Polling interval for reimbursement reconciliation |

## Testing

```bash
cd graphql-gateway && npm test
cd rails-api && bin/rails test
```
