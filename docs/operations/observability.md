# Health, telemetry, incident operations and hardening

This scaffold provides capped Docker JSON logs (`10m` × 3 per service) and honest basic container liveness probes. It does **not** include working OpenTelemetry/Prometheus/Grafana plumbing, measured workloads or a real worker heartbeat.

| Component | Current signal | What it does not prove |
|---|---|---|
| Postgres | `pg_isready` | RLS/tenant safety, migrations, restore capability |
| API | `GET /healthz` | identity, DB readiness, approval correctness |
| Web | `GET /_healthz` | Vue functioning, backend/API correctness |
| Redis (optional) | `redis-cli ping` | quota durability or authoritative state |
| Ollama (optional) | `ollama list` | configured model exists or extraction passes evaluation |
| Worker | process status only | an outbox job ever completes, lag, lease renewal |

The worker must add a truthful heartbeat/queue-lag metric. API should expose a separate authenticated dependency-aware readiness probe, not misuse `/healthz` as a security gate. Never log briefs, JWTs, PostgreSQL URLs, provider secrets, tenant PII or raw customer assets.

## Operational/business signals to add during integration

- Business outcome rate: extracted fields with valid evidence, missing-quantity blockers, deterministic estimate success, revisions eligible for review, different-principal approvals, exact-revision exports and genuine audit visibility.
- Tenant authorization denials, OIDC JWKS/issuer failures, idempotency collisions, stale revision and replay attempts.
- Outbox age, job throughput, lease expiry, retries, dead-letter counts and poison queue.
- Inference request routing, provider/model id, timeouts/retries, circuit breaker, reservation and settlement in precise minor units. **Unknown token usage stays unknown**, never assumed zero.
- API p95/p99, error class by endpoint, request IDs, DB disk/WAL growth, connections, backup freshness, restore rehearsal age, CPU/RAM, host disk, restart rates, request size and log truncation.

## Triage

```sh
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml ps
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml logs --tail=100 postgres migrate api worker web
```

If `migrate` fails, do not bypass its dependency gate: inspect partial DB schema and migration transaction safety. If API is unhealthy, confirm secret mount/identity config and health route without dumping env variables. If nginx is healthy but `/v1` is broken, inspect reverse proxy route and API health. If Ollama lists zero models, pull the exact configured ID; remote BYOK failures require allowlist/budget reconciliation checks, not logging credentials. For stuck jobs, do not hand-delete leases without an idempotent recovery plan.

## Internet-exposure security gate

Use externally managed TLS/HSTS, host firewall, trusted proxy headers, token issuer/audience/JWKS validation and trusted membership checks. Review base-image versions and pin approved digests; scan dependencies and set OS/container disk, memory and FD limits appropriate to real measurements. The upstream Ollama container user still needs hardening review; it has no host port or privilege/device mounts here. Ensure per-tenant DB RLS and row ownership — Docker networks are not a tenancy mechanism. Test encrypted offsite restore, cross-tenant access, prompt injection, stale reviews, replay attacks and billing reconciliation before external users are invited.
