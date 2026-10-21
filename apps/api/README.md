# Scopehatch Fastify API — Sprint 01 adapter

This folder implements the frozen v1 REST contract through verified JWT identity, tenant-scoped application transactions, the **existing** pure domain kernel and injected ports. The PostgreSQL worker owns durable storage separately. The in-memory database here is explicitly a **test double**, never a deployment fallback. This is not a production-ready server.

## Verify in a full repository checkout

Requires Node.js 22+ and an npm registry connection.

```sh
cd apps/api
npm install
npm run check
```

`npm run check` compiles to `dist/` and runs Node tests, including Fastify `inject()` tests with locally generated RS256-signed JWTs. The package imports the domain kernel via `../../../src/domain.mjs` and sets the TypeScript `rootDir` to `src` so this path remains correct after emitting the build. Do not copy `apps/api` out of the repository checkout. No root package manifest, root CI or shared kernel was changed.

## Integration entrypoint

```ts
import { start } from './apps/api/dist/index.js';
import { databaseAdapter, membershipAdapter } from './integration/adapters.js';
await start({ store: databaseAdapter, memberships: membershipAdapter });
```

Set `OIDC_ISSUER`, `OIDC_AUDIENCE` and an administrator-approved HTTPS `OIDC_JWKS_URL` before starting; optional `HOST` and `PORT`. `npm start` intentionally refuses to start without real adapters. No static signing secret or role header bypass is included. `oidcVerifier({localJwks})` exists only for test-issued signed JWTs.

The API verifies asymmetric signature (RS256 or ES256), issuer, audience, expiry, issued-at and subject. The external `sub` is resolved through `MembershipPort` to trusted actor/tenant/role records. Client body claims `roles`, `actorId` and `tenantId` cannot grant access; unknown JSON body fields are rejected. Optional `X-Workspace-Id` selects **only** among active memberships returned from trusted storage, and multiple memberships without selection fail closed. In production, bind the configured issuer and subject into a globally unique identity key in the trusted membership registry. Membership lookup must fail closed on errors.

## Implemented routes

- `GET /healthz`: liveness only
- `GET /v1/catalogs`, `POST /v1/projects`, `GET /v1/projects/:id`
- `POST /v1/projects/:id/scopes`, `/estimates`, `/reviews`, `/approve`
- `GET /v1/projects/:id/exports/:revision`, `/audit?cursor=&limit=`
- `POST /v1/projects/:id/suggestions`: authenticated, requires an idempotency header, explicitly responds `503 PROVIDER_UNAVAILABLE` until the governed extraction worker is integrated. Never mutates scopes, prices or approvals.

Every successful state-changing POST uses `Idempotency-Key`: same tenant+actor+method+path+key and semantic request body returns the original status and response; a different body returns 409. Body input is JSON schema validated and errors return `{error:{code,message,requestId}}`. Cross-tenant object reads and writes return 404. Insufficient role returns 403. The domain kernel alone calculates prices and enforces separate human approval. Scope or catalog changes invalidate quote/export eligibility, but do not erase earlier immutable records. The audit timeline supports cursor pagination without exposing raw briefs or secrets.

## Persistence adapter requirements (integration PR)

`PersistencePort.transaction(principal, action)` must start a DB transaction with verified tenant/actor identity installed using `SET LOCAL` or equivalent; enforce PostgreSQL RLS on all row operations and never leave pooled session state behind. All `UnitOfWork` methods must operate only on that principal's tenant, and `listCatalogs()` returns the newest version first. Immutable project intakes, catalog versions, scopes and estimates require unique keys and composite tenant foreign keys.

For safety under crashes and concurrent callers, **one atomic DB transaction** must cover record mutations, append-only audit events, HTTP idempotency record writes and approval compare-and-set. Required uniqueness includes (tenant,project,scopeRevision), (tenant,project,scopeRevision,catalogVersion) for estimates/reviews, and (tenant,actor,method,path,key) for idempotency. `approveReview` must only transition the exact current pending tuple to approved when one row matches. The fake serializes transactions in a single process but is not evidence of PostgreSQL behavior, durability or multi-instance safety.

## Remaining gates

Integrate real PostgreSQL and trusted membership storage; run RLS/pool-leak/concurrency/interruption tests against an actual DB. Wire a protected inference/budget adapter behind the unavailable suggestions route. Add deployment-specific rate limiting, logging redaction, identity key rotation tests, readiness checks, backups, incident procedures and root package/CI wiring in the authorized integrator PR. Do **not** treat this adapter-only PR as a deployed service or a completed durable persistence integration.
