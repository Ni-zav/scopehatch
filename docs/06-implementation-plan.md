# Execution plan and gates

**Five focused prototype build days**, not a guaranteed production SaaS launch.

| Day | Deliverable | Non-negotiable gate |
|---|---|---|
| 0 | Product scope, contract, fixtures, architecture | No built/benchmark claims |
| 1 | Domain kernel, scopes, catalogs, quotes, reviews | Tenant isolation, quote blockers, revision invalidation |
| 2 | Fastify API, PostgreSQL schema, auth, migrations, Vue minimal workbench | Same rules through UI and API, persistent audited state |
| 3 | One real local or BYOK model, schema extraction and evidence, provider router and spend reservations | AI never determines final price or approval |
| 4 | Async jobs, evaluation suite, workpack registration and trace/usage view | Concurrency, timeout, injection and tenant tests |
| 5 | Portable Compose, CI, docs, load test and 3-minute honest demo | Third-party reproducibility and reported limitations |

## Current actual status
- Planning documents and original inference research committed.
- Domain kernel and unit tests are being implemented separately. No API, database, UI, model integration or live deployment is claimed complete until independently verified.

## Priorities
P0: reliable human workflow, immutable revision-bound approval, one tenant-safe persistent API, deterministic quote, one real model, evaluation evidence and one-click-ish Compose.
P1: MCP adapter, PDF text ingestion, tracing dashboard, provenance viewer, team controls.
P2: vLLM GPU, Kubernetes/Helm, hosted billing, multiple providers, CRM and email automations, visual workflow editor.

## Issues to track
1. P0-01 Domain kernel + tests.
2. P0-02 Database, tenant isolation and migrations.
3. P0-03 HTTP API with verified identity and idempotency.
4. P0-04 Vue review and manual proposal export.
5. P0-05 Inference adapter, structured extraction and evidence.
6. P0-06 Provider policy, quotas and cost ledger.
7. P0-07 Golden evaluation, fault injection and attack tests.
8. P0-08 Docker Compose, CI and reproducible demos.

Never bypass tests to meet a day estimate. Cut UI polish and extra providers first.