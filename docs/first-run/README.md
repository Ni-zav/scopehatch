# First Scopehatch workspace — trusted, offline provisioning

**Scope:** Sprint 02 admin bootstrap, **not** public signup. Uses the existing PostgreSQL schema and verified OIDC subject-to-membership lookup. Creating the tenant does **not** log anyone in; a signed JWT and API membership lookup must separately succeed. This guide intentionally does not apply fixture seeds or create model budgets/catalogs.

## 1. Prepare and verify prerequisites

1. Set up a non-public PostgreSQL 17 host or the documented `deploy/compose.yaml` + `deploy/compose.prod.yaml` stack; keep DB on the internal Compose `backend` network. Back up existing data before changes. Run migrations `001_initial.sql` through `007_tenant_identity_issuer.sql` using the dedicated migration identity. Confirm the tenant, membership and issuer-registry tables exist. **Never** use the API runtime account for provisioning. Existing tenants need explicit issuer verification/binding after this upgrade, as described below.
2. Configure an external, trusted OIDC provider with an authorization-code + PKCE browser client, a JWT **access token** audience matching `OIDC_AUDIENCE`, and a trusted HTTPS issuer/JWKS URL. Confirm that production API's `OIDC_ISSUER`, `OIDC_AUDIENCE` and `OIDC_JWKS_URI` are the same provider and environment that you are provisioning. `OIDC_ISSUER` comparison is exact, including any trailing slash. Reject `.invalid`, sample issuer endpoints or development issuer accounts for live customer databases. Do not use synthetic `studio-a`, `studio-b` or their fixture subjects.
3. Get the initial owner's **immutable `sub` identifier**, not their email/handle, using your IdP's trusted administrator console or a verified signed access token from that user's real login. For an independent cryptographic check, obtain a short-lived JWT access token via your IdP's documented legitimate browser PKCE login (not a fabricated token), put it temporarily in a restricted `0600` file in a private directory, and validate it with `jose` against the configured provider JWKS. Example local *verification only* script, after `npm ci` in repository root:

   ```sh
   # EXPECTED_OWNER_SUB comes from IdP's trusted user record (exact characters).
   # TOKEN_FILE is a 0600 temporary access-JWT file, never committed/logged.
   export EXPECTED_OWNER_SUB='copy-exact-sub-from-idp-admin-record'
   export TOKEN_FILE='/secure/temporary-owner-access-jwt'
   node --input-type=module <<'JS'
   import { readFileSync } from 'node:fs';
   import { jwtVerify, createRemoteJWKSet } from 'jose';
   const token = readFileSync(process.env.TOKEN_FILE, 'utf8').trim();
   const { payload } = await jwtVerify(token,
     createRemoteJWKSet(new URL(process.env.OIDC_JWKS_URI)), {
       issuer: process.env.OIDC_ISSUER,
       audience: process.env.OIDC_AUDIENCE,
       algorithms: ['RS256','ES256'],
       requiredClaims: ['iss','aud','sub','exp','iat'], clockTolerance: 0
     });
   if (payload.sub !== process.env.EXPECTED_OWNER_SUB) process.exit(1);
   process.stdout.write('Signed access token and expected subject match.\n');
   JS
   # Securely remove the temporary token as appropriate for your host/storage.
   ```

   Do not run token decoders that trust unsigned claims or paste JWTs into websites. The JWT verification example needs outbound HTTPS connectivity to the *approved* JWKS URI and the same issuer/audience as the real API. The trusted IdP console can be used instead if no access token is available; record the operator's verification in your private change ticket. The CLI's `--confirm-subject-verified` records an acknowledgement, **not** a cryptographic proof.
4. Set `OIDC_ISSUER` and `SCOPEHATCH_DEPLOYMENT_ENV` in the trusted provisioning process environment; environment must be one of `production`, `staging`, `development`. Use the **real production issuer**, not a demo. Decide a stable lowercase tenant slug and a printable workspace display name. Confirm the expected PostgreSQL database name with `--confirm-database` to prevent cross-environment accidents.
5. Ensure an explicit **separate** admin PostgreSQL URI is available **only to a trusted one-shot provisioner** as an owner-only file (`0400` or `0600`, no symlink). The current schema uses FORCE RLS on tenants, so the privileged database identity must have BYPASSRLS or superuser and DML on both tables. This is a powerful credential: don't leave it in production API/worker/web environment variables, image layers, shared volumes, arguments or logs. Never mount admin credentials into the API or web containers.

## 2. Offline invocation

Run on a trusted host that can connect to PostgreSQL, after installing the repository's existing Node dependencies. The path below is a **local private file**, not a raw password in shell history.

```sh
export OIDC_ISSUER='https://<real-provider-issuer>/'
export SCOPEHATCH_DEPLOYMENT_ENV=production
export OWNER_SUB='copy-the-exact-verified-sub' # not an email address
export ADMIN_DB_URI_FILE=/secure/scopehatch-admin-db-uri

node tools/onboarding/cli.mjs tenant create \
  --tenant-id acme-studio --workspace-name 'Acme Studio' \
  --owner-sub "$OWNER_SUB" --issuer "$OIDC_ISSUER" \
  --environment production --confirm-database scopehatch \
  --admin-db-url-file "$ADMIN_DB_URI_FILE" --confirm-subject-verified --dry-run

# If the dry run confirms the intended operation, omit --dry-run:
node tools/onboarding/cli.mjs tenant create \
  --tenant-id acme-studio --workspace-name 'Acme Studio' \
  --owner-sub "$OWNER_SUB" --issuer "$OIDC_ISSUER" \
  --environment production --confirm-database scopehatch \
  --admin-db-url-file "$ADMIN_DB_URI_FILE" --confirm-subject-verified
```

`--help` prints flags and exits without accessing DB. `--dry-run` starts a read-only transaction and reports `would-create` or `would-be-unchanged`; it does not reserve IDs. Successful write prints `created` or `unchanged` only **after COMMIT**. Repeat with the same values to confirm idempotency. A different owner subject, name, missing/inactive owner or extra owner is a conflict (exit `3`), not an opportunity to overwrite roles. A failed insertion rolls back the whole transaction. A DB outage, unexpected SQL error or missing permissions is exit `4`; bad issuer, credentials file permissions, runtime login, DB-name mismatch or environment confirmation is exit `2`. Errors never print DB connection strings or JWTs.

### Docker Compose deployment constraint

The existing Compose stack intentionally does **not** expose Postgres on a host port and the API/web containers never receive admin credentials. The Sprint 02 integrator must package this `tools/onboarding/` entrypoint into a **one-shot** administrative execution context on the internal backend network (for example, `docker compose run --rm --no-deps` with a separately mounted private URI file on the *migrate* service image, which already has Node and root `pg`). The role must be the migration/provisioning role, **not** `scopehatch_runtime`. Do not temporarily publish a database port or copy the admin URI into an API container to make the command work. The existing API Dockerfile `COPY . .` includes new tools after the image is rebuilt, but there is no root `scopehatch-admin` bin, Compose service or release CI wiring in this worker-owned PR.

An operator can use this pattern once the images have been rebuilt with the CLI and the privileged URI file is mounted as read-only to UID 1000 **only for the one-shot migrate execution**:

```sh
# POSTGRES_DB and OIDC_ISSUER should come from the reviewed .env on the host.
# Keep deploy/secrets/admin_provision_url out of Git, mode 0400 and owned by UID 1000.
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml up -d postgres

docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml \
  run --rm --no-deps -T --entrypoint node \
  -e SCOPEHATCH_DEPLOYMENT_ENV=production \
  -v "$PWD/deploy/secrets/admin_provision_url:/run/secrets/admin_provision_url:ro" \
  migrate tools/onboarding/cli.mjs tenant create \
  --tenant-id acme-studio --workspace-name 'Acme Studio' \
  --owner-sub "$OWNER_SUB" --issuer "$OIDC_ISSUER" \
  --environment production --confirm-database "$POSTGRES_DB" \
  --admin-db-url-file /run/secrets/admin_provision_url --confirm-subject-verified --dry-run
```

Re-run without `--dry-run` when verified. The private URI file should point at `postgres:5432`, use the privileged migration database login/password (URL-encode components), and be securely removed or rotated after bootstrap according to host policy. Ensure the URI file is never committed and the file's host UID matches the one-shot process; the CLI rejects world/group-readable files. `docker compose run` is intentional—**do not** change persistent `migrate`, `api` or `web` service secrets to include this URI.

## 3. Confirm account access without privilege shortcuts

1. Sign in as the actual initial owner via the provider's normal browser Authorization Code + PKCE flow. API verifies JWT signature, `iss`, `aud`, `exp`, `iat`, and `sub` using trusted issuer/JWKS. The API then calls `scopehatch.lookup_verified_subject(sub,issuer)`; it uses active DB membership within the persisted exact issuer binding, **not client-supplied roles**. An unbound tenant or different issuer/subject receives no membership.
2. For multi-workspace accounts, use `X-Workspace-Id` **only** to select one existing authorized membership; it never creates or promotes memberships. Try a foreign workspace selector and a token with a wrong subject and confirm both fail. A healthcheck alone proves none of this.
3. A verified owner creates the **first** service catalog with `baseVersion:0` and explicitly chosen currency/price; then creates a project, adds an evidence-backed scope, requests a deterministic estimate, and asks an independently verified reviewer to approve the exact revision. Use the host-only `member add` operation with `--role reviewer` to enroll that distinct verified human, following [the member lifecycle guide](../../tools/onboarding/README.md#issuer-binding-and-member-lifecycle). The tenant-create command does not insert a demo catalog, reviewer or synthetic pricing. Do **not** temporarily make yourself a fake reviewer or use seed actors.
4. Verify audit trails and tenant separation with real restricted app credentials; store operator provisioning change-record and privileged DB logs securely. Application audit events are not automatically generated by initial offline bootstrap in Sprint 01 schema. Confirm backup/restore with the operations playbook before exposing the installation.

## 4. Integrator-owned follow-ups and limits

- **Naming mismatch:** frozen S02 contract names `tools/admin/**` and `scopehatch-admin`; this worker is explicitly scoped by request to `tools/onboarding/**`. Add an alias/launcher from integrator-owned root files or agree a contract amendment. Do not create a competing second provisioner.
- **Existing issuer bindings:** migration 007 never guesses the issuer of historical memberships. Verify every existing subject against the intended IdP, then run `tenant bind-issuer` with the verified active owner's confirmations and `--confirm-existing-memberships-verified`. Until then, access fails closed. A different persisted issuer conflicts; issuer rotation requires a separately reviewed migration. See [the identity administration guide](../../tools/onboarding/README.md#issuer-binding-and-member-lifecycle). Neither email nor unverified `sub` suffices.
- **Privilege gap:** FORCE RLS on `tenants` requires BYPASSRLS or superuser for first insert. Design a narrowly delegated owner-provisioning SECURITY DEFINER administrative function/role with hard authorization constraints in a separate reviewed forward migration to minimize standing privilege. Never grant this capability to the runtime or public API.
- **Deployment/CI:** add `scopehatch-admin` executable alias, one-shot network/secret wiring and `node --test tools/onboarding/test/*.test.mjs` plus disposable Postgres invocation. Keep admin secrets separate from root runtime `.env` and all normal containers. This workstream cannot edit root manifest, Compose, migrations or release gates.
- **Tenant metadata:** only a name is supported by the present `tenants` table. Structured address, locale, time zone and branding are separate product/data contracts, not silent extra database writes.
- **Identity audit:** `--confirm-subject-verified` is an explicit trusted human assertion; retain a private audit record of which operator checked the IdP identity. For higher assurance, require a signed challenge/proof workflow in a later contract.

## 5. Verification evidence

Locally run `node --test tools/onboarding/test/*.test.mjs` for no-network unit checks. A PostgreSQL integration test under `tools/onboarding/test/postgres.integration.test.mjs` is opt-in using `TEST_PG_ADMIN_URL`, `TEST_PG_DATABASE`, and optionally `TEST_PG_APP_URL` for a disposable DB. Its skip status is not equivalent to successful DB testing. See [`tools/onboarding/README.md`](../../tools/onboarding/README.md) for commands and remaining boundaries. This PR does not claim a real OIDC login or customer deployment.
