# Integration blockers and app-container assumptions

**Deployment PR scope only:** `deploy/**`, `docs/operations/**`, `.env.example`. No API, web, DB or root manifest/CI edits are made. Parallel workstreams own those files. The current Compose overlay is a contract target, not a booted product.

| Owner | Dependency before one-command demo |
|---|---|
| Integrator | Root `package-lock.json` and npm workspaces `@scopehatch/api`, `@scopehatch/web`, `@scopehatch/persistence`. Ensure `npm ci` succeeds with local package graph and both target architectures. |
| API | `build`, `start`, `dev`, `start:worker`, `dev:worker` scripts; server binds `0.0.0.0:3000`, exposes `GET /healthz`; signed JWT issuer/audience/JWKS/expiry and DB membership are authoritative. |
| Persistence | Re-runnable transaction-safe `db:migrate` npm script in persistence workspace, `DATABASE_URL` connectivity, seeded synthetic catalogs and distinct tenant A/B/operator/reviewer members where appropriate. |
| API + DB | Immutable scope and catalog revisions, tenant-safe authorization at each operation, idempotency, genuine separate-actor approval, exact approved export, audit log and restore integrity. |
| WEB | `apps/web/dist` build output, relative same-origin `/v1` fetches; for dev, Vite proxy routes `/v1` and `/healthz` to `http://api:3000`. |
| AI + GOV | Adapt `SCOPEHATCH_INFERENCE_PROVIDER`, `SCOPEHATCH_INFERENCE_BASE_URL`, `SCOPEHATCH_INFERENCE_MODEL` and optional `OPENAI_API_KEY` to governed provider routes; tenant budget + allowlists must be enforced. |
| Worker + integrator | PostgreSQL outbox/lease processing, graceful cancellation, replay safety and a real heartbeat/queue-lag signal; process status is not work completion. |
| Integrator | Root CI/workspace scripts, auth fixture or trusted issuer, seeded demo flows, cross-tenant/injection/revision tests and measured end-to-end Compose boot/restore drill. |

## Container contracts

- `Dockerfile.api`: root-context `npm ci`, build `@scopehatch/api`, prune dev dependencies in runtime. Shared app image starts `npm run start --workspace @scopehatch/api` for API or `start:worker` for worker.
- `Dockerfile.web`: root-context `npm ci`, build `@scopehatch/web` and copy `apps/web/dist` into non-root nginx.
- `migrate` runs `npm run db:migrate --workspace @scopehatch/persistence`; it must be safe to rerun after interrupted transactions.
- `service-entrypoint.mjs` creates a properly URL-encoded `DATABASE_URL` from PostgreSQL secret file + host/user/db fields and passes it to service environment; hosted-model key injection is file-based. It does not implement auth or policy.
- API requires `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URI`, rejects placeholder issuer and never reads a client-supplied tenant or role as authority.
- App UID/GID 1000:1000, production rootfs read-only, writable `/tmp` only. If uploads require durable storage, add a separately audited volume in integration.
- Worker intentionally has no invented health probe. Integrate truthful heartbeat + outbox age metrics, then add a dependency-aware readiness probe. API `/healthz` remains liveness only.

## Proposed interface decisions (integrator-owned)

Confirm workspace names, app scripts, migration and seed strategy, exact provider-env adapter, OIDC test issuer/JWKS workflow, Vite proxy, and worker readiness. These are **proposed integration assumptions**, not unilateral changes to `contracts/sprint-01-interface.md`. Security-sensitive changes must be reviewed as a single integration PR.

## Release gate

Do not label the deployment complete until: Compose config and images build on a real Docker host; migration exits 0; Postgres/API/web healthy; worker actually processes jobs; signed tenant A/B identities run immutable brief/scope/estimate/review/export/audit flows with no cross-tenant leakage; approval is by a different verified principal; and stale revision, replay, malicious brief and unknown usage tests pass. The final review needs tested backups and cost/identity checks.
