# Offline trusted tenant bootstrap

This is a **host/operator-only** administrative tool, not an HTTP API, SDK method, user registration flow or runtime service. Run after migrations `001`–`005`. It creates precisely one `scopehatch.tenants(id,name)` row and one active `scopehatch.memberships(tenant_id,principal_id,roles=['owner'])` in one transaction. No catalog, model-policy, budget, seeded test actors or extra memberships are created.

- Entry point: `node tools/onboarding/cli.mjs tenant create --help` or `node tools/onboarding/cli.mjs --help`.
- Installation: Node >=22 and the repository's existing npm-installed `pg` dependency. No new package manifest or root script is added. The integrator must provide the eventual `scopehatch-admin` alias, CI task, image/Compose wiring and documentation link outside this worker's file ownership.
- Required: `--tenant-id`, `--workspace-name`, `--owner-sub`, `--issuer`, `--environment`, `--confirm-database`, `--admin-db-url-file`, `--confirm-subject-verified`. `OIDC_ISSUER` and `SCOPEHATCH_DEPLOYMENT_ENV` must exactly match the command's issuer and environment. `--dry-run` is a read-only check; success does not reserve the tenant ID.
- Provisioning DSN: a regular owner-only file (`0400` or `0600`, no symlink) containing a PostgreSQL connection URI for a migration/provisioning role with `BYPASSRLS` or superuser. This high-privilege requirement follows the **current** FORCE RLS schema; introduce a narrowly delegated admin SECURITY DEFINER capability in an integrator-reviewed migration before eliminating this dependency. Never pass the DSN on a command line or expose it to API/web containers. A connection identical to the process's runtime `DATABASE_URL` is rejected.
- Verification: `--owner-sub` is an **exact** (case-sensitive) OIDC subject from the **configured trusted issuer**; it is not an email or username. `--confirm-subject-verified` is a privileged operator's explicit acknowledgement of an external subject check, not a token verification implementation. Details: [first-run walkthrough](../../docs/first-run/README.md).

Tenant IDs are intentionally restricted to lowercase slugs (3–63 characters). Names are required (2–120 printable characters); the persisted schema has **no other workspace metadata columns**. Other fields (branding, timezone, policy) need a separate reviewed schema/UX change, rather than arbitrary JSON or undocumented database columns.

A tenant-specific transaction-scoped advisory lock serializes concurrent calls. Repeating the exact tenant/name/sole active owner-role subject returns `unchanged` without mutation, and non-owner memberships added later may coexist. Conflicting existing owner/name/roles, inactive owner, additional owner, or existing tenant with no matching membership is a hard failure; neither identity nor role is silently changed. Existing issuer cannot be compared with historical rows because Sprint 01 stores `principal_id` without issuer, so the operator must maintain a secure issuer-tenant inventory until the integrator adds persistent issuer binding. Changing issuers requires an explicit authorized migration; **never** rerun this CLI with a guessed replacement subject.

Only `tenant=<slug> outcome=<created|unchanged|would-create|would-be-unchanged>` is printed on success. Raw PostgreSQL diagnostics, owner subjects, JWTs, passwords and URLs are not logged. Failure exits are `2` invalid configuration, `3` conflicting state, `4` DB/permissions/connectivity failure; success and read-only dry-run are `0`. Logs are not a full audit of administrator identity; the host's process/execution audit must be retained separately.

## Local tests

```sh
node --test tools/onboarding/test/*.test.mjs
```

Unit tests use an injected transaction-capable driver fake and require no network. The PostgreSQL test is **skipped**, not passed, without `TEST_PG_ADMIN_URL`. For actual PostgreSQL evidence, first migrate a **fresh disposable test DB** (never a customer database), with `pg` already installed, then:

```sh
TEST_PG_ADMIN_URL='postgresql://...disposable...' TEST_PG_DATABASE='scopehatch_test' \
  TEST_PG_APP_URL='postgresql://...restricted-app-in-same-disposable-db...' \
  node --test tools/onboarding/test/postgres.integration.test.mjs
```

The integration test leaves uniquely named synthetic tenant rows in that disposable DB; discard the entire DB afterwards. It verifies concurrent idempotency, exact membership, owner conflict and rejection of a runtime role. Do not run with a production DB, even if you intend to clean up: immutability and RLS make deletion unsafe.
