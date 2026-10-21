# PostgreSQL persistence — Sprint 01 (issue #2)

**Status:** implemented, but not yet validated against a live PostgreSQL server
in this authoring environment. Source files are not evidence of successful RLS
tests or production readiness.

## Prerequisites and install

PostgreSQL >=14; Node.js >=22; local npm package dependency pg.

Use TWO different database roles. The migration/provisioning role can create
roles, tables, triggers and policies, and the demo seed requires an
administrator with BYPASSRLS/superuser privileges. The app role must not be a
superuser, BYPASSRLS, schema owner or table owner. It should have INHERIT and
membership in the scopehatch_app NOLOGIN role. Never use the migration DB
connection string in the public API.

In a fresh dedicated database, from the repository root:

    psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -f db/migrations/001_initial.sql
    psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -f db/migrations/002_quote_integrity.sql
    psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -f db/migrations/003_immutable_children_usage.sql

Provision the restricted app login through a protected administrator session:

    CREATE ROLE scopehatch_web LOGIN INHERIT PASSWORD '<generated secret>';
    GRANT scopehatch_app TO scopehatch_web;

For **demo/test only**, with privileged provisioning credentials:

    psql "$PG_ADMIN_URL" -v ON_ERROR_STOP=1 -f db/seeds/001_studios.sql

The seed creates reproducible Studio A / Studio B identifiers, memberships,
catalogs, briefs, projects, scopes and ready estimates; only Studio A has a
pending review. These are fictional data and identities, not credentials.
Seed and migration are intended to be idempotent for their fixed fixture IDs.
Do not seed a live customer database or expose predictable fixture actors as
authenticated users.

To run the integration suite with a real PostgreSQL database (not pg-mem):

    cd packages/persistence
    npm install
    npm run check
    TEST_PG_ADMIN_URL='postgresql://migration-user@localhost/scopehatch_test' \
    TEST_PG_APP_URL='postgresql://scopehatch_web@localhost/scopehatch_test' npm test

Both URLs must point to a **disposable test database**. The test suite
checks the app role has neither superuser nor BYPASSRLS and does not own
the tables. Without both URLs, tests are marked skipped, not passed.
The suite leaves synthetic fixtures and test records in the database.

## API adapter usage

    import pg from 'pg';
    import { createPersistence } from './packages/persistence/index.mjs';
    const store = createPersistence(new pg.Pool({ connectionString: process.env.DATABASE_URL }));
    const response = await store.withPrincipal(verifiedPrincipal, tx =>
      tx.idempotent({
        key: verifiedIdempotencyKey,
        operation: 'POST /v1/projects',
        payload: { title: 'Example', brief: 'Three images' },
        execute: repo => repo.createProject({ title: 'Example', brief: 'Three images' })
      })
    );

VerifiedPrincipal MUST come from JWT/OIDC signature, issuer, audience,
expiry checks and selection of a trusted tenant membership by the API.
The persistence package independently reads active roles from PostgreSQL;
it does not trust role claims from the caller or any HTTP body. Do not
expose a raw SQL connection through the API.

Every withPrincipal invocation runs BEGIN, SET LOCAL tenant/actor, a
membership check, the scoped operation, and COMMIT or ROLLBACK. The pooled
client is released afterwards; session context cannot bleed to the next
request. All tenant-owned tables have tenant-scoped RLS. Nearly all have
FORCE RLS, and composite foreign keys prevent reference mixing across tenants.
The application role has no INSERT/UPDATE/DELETE grants on memberships.

Catalogs, intakes, scopes, deliverables, estimates, idempotency records,
usage and audit are append-only by trigger. Fixed child counts and creation
transaction IDs prevent direct SQL from appending a new service or deliverable
to an existing version even if its line count is incomplete. Reviews are pending -> approved only;
review transitions guard reviewer role, separation of duties, exact immutable
estimate binding, latest intake, scope, catalog, and estimate identity.
Tenant-then-project locks serialize revision creation, quote creation and
approval, preventing a concurrent edit from leaving a stale approval.
The approval event and review transition commit atomically.

READY estimates are calculated by the pure domain code and independently
rechecked in PostgreSQL using catalog rates, quantities, brief evidence,
blockers, minor-unit exact totals and safe integer bounds. A raw SQL ready
estimate cannot supply arbitrary prices. App-generated JSON must match
the persisted catalog-bound representation.

Idempotency is transaction-atomic. A tenant+key advisory transaction lock
serializes callers. The immutable stored row binds the actor, operation,
canonical JSON request hash and JSON response. A matching replay does not
repeat execution; changed actor/body/operation returns a conflict.

Audit metadata must be minimized and redacted; never put raw briefs,
credentials or personally identifying client assets there.

## Security limitations

RLS checks both transaction tenant and authenticated membership. It
prevents direct cross-tenant SQL reads and writes **when the trusted session
context cannot be changed**. PostgreSQL custom configuration parameters
used here (scopehatch.tenant_id and scopehatch.actor_id) are writable by
SQL under the application account. Thus an attacker with arbitrary SQL
execution under the shared app login could change BOTH to impersonate another
known active membership. This is NOT a fully injection-resistant tenant
boundary. The API must only use parameterized repository queries and never
expose arbitrary SQL. For a stricter threat model, the integrator should
add database-verified signed transaction attestation or isolated tenant
database credentials before calling this production secure.

Other limitations: no production identity provisioner, budget ledger
reconciliation, operational migration runner, backup/restore or incident plan,
real customer validation, external security audit or live PostgreSQL test
evidence from this execution environment. Immutable records have no
nondestructive down migration; rollback needs restore or a reviewed forward
migration. Never automatically DROP SCHEMA on a live database.

## Integration lead — PROPOSED CONTRACT ADAPTER

1. The HTTP API accepts scopeRevision/catalogVersion in review/approve routes,
   while persistence requires estimateRevision/reviewId for exact binding.
   Resolve the current matching IDs server-side, never trust IDs from bodies.
2. The API must require Idempotency-Key on every POST and wrap writes in
   tx.idempotent. Internal scoped methods can be called without replay
   protection by migration/admin code; this is not sufficient for an HTTP API.
3. Implement JWT/OIDC verification and guarded membership provisioning
   outside this package. Authentication errors are returned by the API.
   Map NOT_FOUND to 404, FORBIDDEN to 403, validation to 422 and stale or
   idempotency conflicts to 409. Include request IDs in HTTP error objects.
4. listReviews, getProject and exportApproved support the project GET and
   approved exact-revision export adapter. Export produces Markdown but never
   sends anything. Project status is derived from bound records, not mutable
   without review.
5. Governance can record provider token usage through recordUsage and listUsage.
   Unknown usage remains null; no dollar spend reservation/settlement is
   implemented by this package. Provider provenance validation is the caller's
   responsibility.
6. Wire package install and test commands into the root workspace and CI
   from a separate integrator PR. Provision least-privilege DB login, demo
   identity, migrations, secret management and a real Postgres test service.
7. This work owns only packages/persistence and db. Do not change domain,
   API, shared contracts, CI, or another worker's files for integration.
