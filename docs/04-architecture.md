# Architecture — product first, inference underneath

```text
Vue operator workbench ──┐
REST/SDK/agent caller ────┼─> Fastify API (auth, tenant, RBAC, idempotency)
                          ├─> Scope domain (immutable revisions and rules)
                          ├─> Approval service (separation of duties)
                          └─> Workpack runtime ─> Governed inference router
                                  │                 ├─ local Ollama / GPU vLLM
                                  │                 └─ hosted BYOK providers
                                  └─> tools / retrieval / schema validators
PostgreSQL: authoritative source, catalogs, audit, outbox, budget ledger
Redis: opportunistic rate limiting/cache only, never final quota accounting
Worker: PostgreSQL outbox/lease processing; dedupe and retry
OpenTelemetry → Prometheus/Grafana: usage, tail latency, errors, eval traces
```

## Proposed long-term stack
Node.js LTS + TypeScript + Fastify, PostgreSQL + Kysely (pgvector only once needed), Vue 3/Vite, Docker Compose for small self-hosted installs, Redis as optional accelerator, Ollama for simple local mode, vLLM for optional GPU mode, OpenTelemetry, Vitest/node:test, Playwright and k6. Helm/Kubernetes and Go extension are P2—not MVP.

## Deployment modes
(1) Standalone self-host: local/managed Postgres, BYOK provider or Ollama, single worker. (2) Hosted BYOK with TLS, stronger isolation and monitoring. (3) Optional GPU cluster with vLLM after model routing benchmarks. No mandatory Kubernetes in community quickstart.

## Model routing
A model is selected based on tenant allowlist, requested capability, context size, data residency, deterministic budget reservation, observed reliability and price—not marketing labels alone. Fail closed when no eligible model exists. Record model/version/provider/latency/tokens/cost or unknown usage; never claim $0 when metering fails.

## Separation
`packages/core`: pure domain rules; `apps/api`: HTTP and principal validation; `apps/web`: UI; `packages/inference`: providers, routing, metering; `workpacks/`: declarative flows and schemas; `tests/evals`: quality fixtures. Day-0 executable kernel may be minimal JS before integration; it must not be called a production server.