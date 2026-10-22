# Core workflow and contract boundaries

Workpack `brief-to-proposal` is described by [manifest and schemas](../workpacks/brief-to-proposal/manifest.yaml). This page explains the domain and **observed Sprint 01 implementation**; JSON shapes and acceptance precedence belong to [Sprint 01](../contracts/sprint-01-interface.md) and the **planned/additive** [Sprint 02 interface](../contracts/sprint-02-interface.md). Do not treat the latter as implementation evidence.

## Domain, revisions and authority

Tenant → project/intake → immutable scope revision → catalog-version-bound estimate → pending review → independent approval → current approved Markdown export. The pure [domain kernel](../src/domain.mjs), [Fastify core](../apps/api/src/core.ts) and [PostgreSQL persistence](../packages/persistence/index.mjs) enforce deterministic money, current revision binding and blockers. The original brief is preserved; catalog service IDs, positive integer or null quantities, exact cited/manual evidence and unresolved requirements drive pricing. Catalog prices and totals are **integer currency minor units**, never LLM-proposed fees.

Blockers include missing/unknown quantities, unresolved requirements, unpriced or unsupported services, absent evidence, no deliverables, currency mismatch and arithmetic overflow. `draft`, `blocked`, `ready`, `pending` and `approved` describe the relevant current record; an export is an audit event, not a new persistent approval status. Changes to scope/catalog require a new revision and fresh estimation/review, retaining immutable history.

The API verifies RS256/ES256 JWT signature, issuer, audience, issued-at/expiry and `sub`; roles and tenant come from **trusted active memberships**, not request bodies, model completions or `X-Workspace-Id` (which only selects an already verified membership). Require a different authorized reviewer; foreign resources return 404, insufficient roles 403, unauthenticated callers 401. Every POST requires a validated `Idempotency-Key`; successful exact replay is idempotent, changed actor/payload/operation conflicts. Structured safe errors are `{error:{code,message,requestId}}`. Persist audit, approval and idempotency transactionally; a healthy endpoint alone does not establish authorization.

## Integrated Sprint 01 REST routes

Declared in [`apps/api/src/server.ts`](../apps/api/src/server.ts):

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/healthz` | Liveness only |
| GET | `/v1/catalogs` | Tenant catalogs, newest first |
| POST | `/v1/projects` | Store titled project and brief |
| GET | `/v1/projects/:id` | Project/current snapshot |
| POST | `/v1/projects/:id/scopes` | New scope revision |
| POST | `/v1/projects/:id/estimates` | Deterministic estimate |
| POST | `/v1/projects/:id/reviews` | Submit for independent review |
| POST | `/v1/projects/:id/approve` | Separate reviewer approval |
| GET | `/v1/projects/:id/exports/:revision` | Exact current approved proposal draft |
| GET | `/v1/projects/:id/audit` | Paginated audit |
| POST | `/v1/projects/:id/suggestions` | Governed **untrusted** extraction suggestion |

[Vue UI](../apps/web/src/App.vue) uses protected API routes in its ordinary build, a **separately labeled synthetic fixture** for `dev`, and [public-client OIDC PKCE](../apps/web/src/oidc.ts) retaining access tokens in memory. It requires a configured IdP plus trusted membership; fixture persona switching is not authentication. [SDK](../packages/sdk/src/client.ts) uses caller-controlled credentials, request cancellation, explicit write keys and no alternate privilege path.

The suggestion API uses [evidence-validated extraction](../packages/extraction/index.mjs), [trusted policy/budget and reservations](../packages/governance/src/index.mjs), [PostgreSQL governance storage](../packages/governance/pg-storage.mjs) and [API adapter](../apps/api/src/inference.ts). Missing real-provider token accounting remains **unknown** with reservation held. The deterministic fixture reports its own measured zero tokens, not live-model quality. No suggestions may set price, catalog, review or approval. [Evaluations](../tests/evaluations/README.md) are synthetic unless a real provider is explicitly run and measured.

## Sprint 02 additions: planned, not in `main` at `0b8e259`

- Owner-only `POST /v1/catalogs`: immutable full replacement, mandatory optimistic `baseVersion` and DB owner enforcement.
- Tenant-only `GET /v1/projects`: newest-first keyset cursor, consistent server-derived status, no brief in list.
- Optional per-line `clientDescription` and scope-bound `proposal` metadata (overview, assumptions, exclusions, commercial terms), normalized for old records. Even **text-only** changes must form a new immutable revision and invalidate old export/review eligibility.
- Host-only administrative **first-tenant/owner CLI** bound to a verified external OIDC subject, no public registration.
- SDK/Vue parity, disposable restore verification, and optional observed real-model benchmark.

See the [frozen contract](../contracts/sprint-02-interface.md), [workstream plan](12-sprint-02-workstreams.md) and [release gates](13-sprint-02-release-gates.md) for exact requirements; **do not duplicate or invent an alternate interface here**.

## Limits and guiding rule

CI exercised synthetic signed OIDC/PG/browser and Compose but **not** a customer identity provider, real model performance, restored production-equivalent backup or public deployment. PostgreSQL RLS plus parameterized queries is defense in depth; [`db/README.md`](../db/README.md) documents a residual arbitrary-SQL risk due to writable custom transaction GUCs. No automatic emailing, signing, CRM, public signup, general workflow engine, Kubernetes or GPU requirement.

**AI completion is not business completion.** A user-facing result requires evidence, catalog price correctness, current immutable binding, permitted human review and an inspectable draft—not a model's confident claim.
