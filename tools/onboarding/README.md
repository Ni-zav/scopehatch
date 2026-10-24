# Offline trusted tenant bootstrap

This is a **host/operator-only** administrative tool, not an HTTP API, SDK method, user registration flow or runtime service. Run after migrations `001`–`007`. Tenant creation writes one tenant, its exact trusted issuer binding and one active owner membership in one transaction. No catalog, model-policy, budget, seeded test actors or extra memberships are created.

- Entry point: `node tools/onboarding/cli.mjs tenant create --help` or `node tools/onboarding/cli.mjs --help`.
- Installation: Node >=22 and the repository's existing npm-installed `pg` dependency. No new package manifest or root script is added. The integrator must provide the eventual `scopehatch-admin` alias, CI task, image/Compose wiring and documentation link outside this worker's file ownership.
- Required: `--tenant-id`, `--workspace-name`, `--owner-sub`, `--issuer`, `--environment`, `--confirm-database`, `--admin-db-url-file`, `--confirm-subject-verified`. `OIDC_ISSUER` and `SCOPEHATCH_DEPLOYMENT_ENV` must exactly match the command's issuer and environment. `--dry-run` is a read-only check; success does not reserve the tenant ID.
- Provisioning DSN: a regular owner-only file (`0400` or `0600`, no symlink) containing a PostgreSQL connection URI for a migration/provisioning role with `BYPASSRLS` or superuser. This high-privilege requirement follows the **current** FORCE RLS schema; introduce a narrowly delegated admin SECURITY DEFINER capability in an integrator-reviewed migration before eliminating this dependency. Never pass the DSN on a command line or expose it to API/web containers. A connection identical to the process's runtime `DATABASE_URL` is rejected.
- Verification: `--owner-sub` is an **exact** (case-sensitive) OIDC subject from the **configured trusted issuer**; it is not an email or username. `--confirm-subject-verified` is a privileged operator's explicit acknowledgement of an external subject check, not a token verification implementation. Details: [first-run walkthrough](../../docs/first-run/README.md).

Tenant IDs are intentionally restricted to lowercase slugs (3–63 characters). Names are required (2–120 printable characters); the persisted schema has **no other workspace metadata columns**. Other fields (branding, timezone, policy) need a separate reviewed schema/UX change, rather than arbitrary JSON or undocumented database columns.

A tenant-specific transaction-scoped advisory lock serializes concurrent calls. Repeating the exact tenant/name/sole active owner-role subject and issuer returns `unchanged` without mutation, and non-owner memberships added later may coexist. Conflicting existing owner/name/roles, inactive owner, additional owner, missing issuer binding or a changed issuer is a hard failure; neither identity nor role is silently changed. Changing issuers requires an explicit authorized migration; **never** rerun this CLI with a guessed replacement subject.

## Issuer binding and member lifecycle

Migration 007 creates an administrator-only `tenant_identity_issuers` registry. API membership lookup uses the exact **verified token issuer and subject together**. An identical subject under a different configured issuer receives no membership. The subject-only SQL lookup is no longer executable by the runtime role. Existing tenants are deliberately left unbound, so their API access fails closed until the operator verifies every existing membership against the intended issuer. No automatic backfill or issuer replacement is provided.

After reviewing the existing tenant's complete member inventory privately, use `tenant bind-issuer` with `--confirm-existing-memberships-verified`. The command requires the verified active owner's `--owner-sub`, tenant ID, issuer, environment, database, protected credential file and `--confirm-subject-verified` as above, but no workspace name. An existing different issuer is always a conflict. `--dry-run` validates without binding.

To enroll a separate human reviewer, use `member add` with the same owner and deployment confirmations, plus `--member-sub` and `--role reviewer`. Only `reviewer` or `operator` is allowed; no owner promotion. The operator must verify both subjects independently against the selected IdP before acknowledging verification. An identical active membership replays without changes; a different role or inactive member conflicts. Membership is scoped to the selected tenant and its persisted issuer. The verified owner and new member must differ.

Use `member disable --member-sub <exact-sub>` with the same owner/deployment confirmations to revoke a non-owner membership. No role argument is accepted. Repetition is unchanged; unknown subjects and owner revocation fail. There is no implicit reactivation, owner transfer, public invitation or HTTP enrollment route. Subsequent API requests re-read active membership; this is not an IdP session/token revocation mechanism. Resolve mistaken revocation through a separately reviewed administrator procedure.

Member and issuer changes append an `admin.*` audit event atomically with the mutation, attributing the verified owner and storing the affected member/role inside the protected DB. Retain host operator execution records separately: the owner acknowledgement does not authenticate the administrator running the command. Dry runs and exact retries do not append duplicate events. New operations print only tenant and outcome; driver errors remain sanitized.

This registry protects against accidental issuer changes, not arbitrary SQL execution under the runtime login. The existing SQL-writable tenant/actor GUC risk remains in [the DB threat note](../../db/README.md). Keep staging private and synthetic, with a single studio deployment; shared externally reachable tenancy still requires independent security review and a separately approved mitigation.

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
