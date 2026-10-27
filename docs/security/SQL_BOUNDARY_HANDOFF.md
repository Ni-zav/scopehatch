# SQL/GUC security handoff — unfinished

**WIP / NOT APPROVED. Do not merge or deploy. Independent security review is required.**
The founder requested an immediate stop and transfer to another PC.

Core branch: `fix/transaction-identity-boundary`, based on `86f3ea9de4c6dd752bcbb1836a557a047650c081`.
Workspace companion: `audit/w27-sql-boundary`. The approved workspace gitlink is unchanged.

## Paste this prompt into Codex on the other PC

Continue the interrupted Scopehatch SQL/GUC security mitigation. Read AGENTS.md, this entire handoff, current release evidence, security contracts and workspace Workstream 27. The founder explicitly authorizes the separate public-core security implementation and workspace readiness notes. Use isolated branches/worktrees and preserve unrelated changes.

Inspect core branch fix/transaction-identity-boundary and workspace branch audit/w27-sql-boundary. Treat the patch as untrusted WIP. Audit the design and implementation, finish the smallest secure mitigation for shared multi-tenant PostgreSQL, and correct security/integration defects. Preserve signed OIDC, active DB membership, RLS, independent reviewer approval, immutable revisions, idempotency and held inference budgets.

Run the relevant PostgreSQL, onboarding, API, SDK, signed synthetic OIDC browser, fixture browser and Docker integration/isolated restore gates on the FINAL candidate SHA. Record real commands, versions, results, failures and skips. Create fresh random fixture secrets outside Git; never copy passwords, tokens, signing keys or databases from the previous PC. Node must be >=22.23.4 and <23. Docker Engine/Compose need authorized local access.

Finish operating/security documentation, open separate core and workspace PRs or update matching existing PRs after inspecting GitHub. DO NOT merge security changes without genuinely independent review. Keep the workspace pin unchanged until independent integration approval. Reassess W27 without equating fixture CI with operational readiness. No deployment, real accounts, billing, live inference or infrastructure purchase.

## Candidate to audit

- Migration 008 introduces a private FORCE-RLS key table and pgcrypto HMAC verification. The trusted application signs purpose-specific attestations bound to tenant/actor or verified OIDC lookup subject/issuer, full transaction ID, backend PID, database, session login and postmaster start time.
- Legacy tenant/actor GUCs grant nothing. Runtime SQL must not read the key or call the administrator signing helper. Challenge ACLs, function ownership/search paths, extension namespace handling and all key-exposure paths.
- Shared Node attestor covers persistence, inference governance and API membership discovery. The administrator-only helper supports offline administration and synthetic SQL fixtures.
- SCOPEHATCH_CONTEXT_KEY_FILE contains 32 random bytes encoded as lowercase hex in a protected regular file. No default key. Migration installs the same key and rejects implicit mismatch. Rotation/recovery operating instructions are unfinished.
- Final API startup changes probe DB/key agreement and reject dangerous SQL privileges. A new context-key file test was added after earlier integration passes. Re-test both.
- Migration runner skips pre-008 migrations on protected databases to avoid reinstalling legacy GUC helpers during restarts. Review upgrade and replay semantics.
- Compose dev/prod and CI inject a separate context_key secret. Changed recovery provisions/restores a synthetic DB key. Its Docker runtime path has NOT been executed.

## Evidence before stopping

These are intermediate working-tree results, NOT verified final-commit evidence:

- Baseline 86f3ea9 reproduced synthetic foreign-project reads and approval as another actor through SQL/GUC substitution. Both effects rolled back.
- Candidate PostgreSQL 17.11: 28 tests passed, zero skipped, including six nested forgery/replay/privilege/pool regression groups. Onboarding: 13 passed, zero skipped.
- Signed PG HTTP 1, inference fixture 2, SDK 1 and S02 PG 1 passed. Signed synthetic PKCE Chromium workflow, unsolicited callback denial and fixture browser suite passed.
- Build/typecheck, unit/eval and deployment Node/Python checks passed before final startup/key changes. Re-run after final edits; do not claim final-SHA coverage.
- Initial test failures included concurrent fixture setup and reusing mutated synthetic DB state. Persistence files now run serially; regression tenants are unique. Successful DB run used a fresh candidate database.
- Disposable audit database container stopped and removed at handoff. Temporary /tmp logs/scripts are not durable or transferable evidence. No credentials or dumps are committed.

## Remaining work

1. Challenge signing-oracle, metadata enumeration, role/search_path, transaction/savepoint/pool and restart/restore replay bypasses. App-process/key compromise and DB administrator compromise are outside the proposed SQL-only boundary. SQL execution can still damage its authorized scope or cause denial of service.
2. Finish key generation/protection, coordinated DB/app installation, explicit rotation, upgrades and encrypted backup/restore documentation. Update db/README.md's old threat statement honestly.
3. Test final startup role/key checks, including mismatch failure before a listener opens. Consider restart/restore replay regressions and meaningful dangerous-role cases.
4. Run changed Docker recovery, Compose preflight/build/boot and image secret exclusion; verify restored RLS, independent approval, audit/replay and held usage. No Docker PASS is claimed for migration 008.
5. Inspect all changes/current refs, commit final candidate, run exact-SHA CI and open separate PRs. Leave security UNMERGED for independent review.

## Test commands after private disposable configuration

Set protected disposable TEST_PG_ADMIN_URL/TEST_PG_APP_URL, matching SCOPEHATCH_CONTEXT_KEY_FILE and migration/runtime password-file configuration; never print their contents.

```sh
node --version
npm ci --no-audit --no-fund
npm run db:migrate --workspace @scopehatch/persistence
npm run test:db
node --test tools/onboarding/test/*.test.mjs
npm run build
npm run typecheck
node --experimental-transform-types --test apps/api/test/postgres.test.ts
node --experimental-transform-types --test apps/api/test/inference.test.ts
node --experimental-transform-types --test apps/api/test/sdk.test.ts
node --experimental-transform-types --test apps/api/test/sprint02-postgres.test.ts
node --experimental-transform-types apps/api/test/browser-oidc-e2e.ts
npm run test:browser
npm run test:unit
npm run test:eval
RUN_SCOPEHATCH_DOCKER_RECOVERY=1 node --test deploy/tests/recovery.test.mjs
```

Use a fresh DB for the full persistence suite: older integration cases assume clean synthetic seed state. Missing DB dependencies produce skips, never passes. Docker 29 previously needed `docker compose ... build api web` to avoid two services exporting the same image concurrently. Do not reuse unknown stacks or delete unknown volumes.
