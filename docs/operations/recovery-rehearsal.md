# Disposable PostgreSQL recovery rehearsal and controlled upgrades

**Scope:** reproducible synthetic-data proof for a single-host Docker Engine/Compose v2 install. No GPU, Redis, Kubernetes, external model, or worker required. This is **not** a production RPO/RTO measurement, nor a rehearsal against a customer's latest actual backup.

## 1. Non-destructive dry run from a checkout

From the repository root:

```sh
node --test deploy/tests/entrypoint.test.mjs deploy/tests/recovery.test.mjs
python3 -m unittest discover -s deploy/tests -v  # requires PyYAML
sh deploy/scripts/rehearse-recovery.sh
# Or run the same full Docker rehearsal under node:test (explicit opt-in):
RUN_SCOPEHATCH_DOCKER_RECOVERY=1 node --test deploy/tests/recovery.test.mjs
```

The rehearsal uses two **new** PostgreSQL 17 containers, named with a randomized prefix and connected with `--network none`. Neither exposes ports nor mounts any live volumes, `.env`, Docker Compose data or customer files. The ephemeral PostgreSQL containers use socket-local `trust` only because they have **no Docker network** and contain synthetic data; production Compose **must never** use `trust` or copy these settings. A cleanup trap removes only containers **whose IDs the script successfully created**, including on failures. The backup archive is in a private temporary directory, automatically erased after the run.

Steps are intentionally observable: apply migrations 001–005, provision a *rehearsal-only* restricted SQL role, apply deterministic Studio A/B fixtures, approve a quote with a distinct reviewer, preserve an earlier scope revision, record an unknown inference reservation and cost hold, run integrity/RLS checks on the source, `pg_dump -Fc --no-owner`, validate `pg_restore --list`, restore into another empty PostgreSQL instance (with required cluster roles), then verify identical per-table content fingerprints, foreign keys, immutable revision guards, tenant read isolation, authorized approval/export eligibility, audit/replay and inference holds. Finally rerun all migrations on the **restored** database and verify that no application row changed.

Synthetic `proposal.approved` in the fixture is **an audit fixture**, not proof that a real browser downloaded a Markdown export. The rehearsal verifies its persisted revision/estimate/reviewer eligibility, not a complete HTTP export transaction; signed API/browser smoke must separately establish that. Per-table digests include every schema column, including Sprint 02 proposal metadata after its migration is integrated, though fixtures must also be extended to make new fields nonempty when that PR lands.

A successful run prints non-sensitive archive size and elapsed backup/restore seconds, alongside `PASS`. To preserve only aggregate evidence without a dump:

```sh
mkdir -m 700 /tmp/scopehatch-recovery-evidence
sh deploy/scripts/rehearse-recovery.sh --keep-report /tmp/scopehatch-recovery-evidence
```

No raw JWTs, SQL rows, client briefs, authentication credentials or dump bytes are written to that report. A nonzero exit means failure. If Docker is unavailable, this is `BLOCKED`, not `PASS`; Node tests skip the Docker test unless explicitly opted in.

## 2. Real backup and recovery policy

The synthetic rehearsal does not replace testing **your actual encrypted backup** in a separately controlled restore host/volume with strictly scoped administrative authorization. Follow [backup-and-restore.md](backup-and-restore.md). Use PostgreSQL **17-compatible** tools, keep schema/grants when restoring (`--no-owner` is okay but do not use `--no-acl` unless you will re-establish and test all privileges), and precreate required trusted cluster roles **before** restore. The application role must remain `NOSUPERUSER NOBYPASSRLS`, and the migration/provisioning credential must not be passed to API/worker/web.

For customer data, separately measure elapsed retrieval, decryption, restore, integrity verification and cutover under approved downtime. The reported practice duration on tiny synthetic fixtures **is not** customer RTO. Determine RPO from the last successful backup/WAL snapshot and confirmed transaction boundary; if not measured, say `unknown`. Keep encrypted off-host archives, retention, key escrow/rotation instructions, verified restore owners and document access permissions. Protect and account for any future object storage independently.

## 3. Controlled single-host upgrade sequence

Never use `docker compose down -v` or `pg_restore --clean` against customer data. Work within an approved change window and record git commit, Docker/Compose/PostgreSQL version, operator and rollback decision.

1. Confirm host disk headroom, current identity configuration, separate reviewer access, and restore-capable encrypted backup. Run the isolated rehearsal above first.
2. Check existing service and DB *without changing data*: `sh deploy/scripts/verify-upgrade.sh before`. If it fails, stop; do not bypass migrations.
3. After an off-host backup and explicit operator approval, deploy a pinned reviewed release via `docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml up --build -d --wait`. The `migrate` one-shot service must complete successfully before the API is allowed to start; do not start the API independently when migrations fail. The `worker` profile remains disabled.
4. Check `sh deploy/scripts/verify-upgrade.sh after`. This read-only gate verifies PostgreSQL socket/schema, the migration container's `exited:0`, and nginx/API HTTP liveness through the actual published web port. It is **not** a substitute for signed OIDC authentication, actual project creation, persisted catalog/revision, independent reviewer approval, exact export and audit checks. Test those before switching traffic.
5. If migration fails, leave writers blocked, preserve old volume and logs (redacted), and diagnose using the migration container exit code. **Never** assume image rollback can reverse a forward-only SQL migration; consider reverting traffic with compatible old code only if schema compatibility has been proven, otherwise recover a new isolated volume from the pre-upgrade archive and cut over after validation.
6. Record observed status and attach sanitized evidence to the integrator's release gate G08. This PR does not alter application code, CI or root manifests; see integration asks below.

## 4. Readiness and diagnostic boundary

Current Compose order is PostgreSQL healthy → migrations succeed → API healthy → web starts. PostgreSQL `pg_isready` and API `/healthz` are **liveness**, not an authenticated readiness proof. `verify-upgrade.sh` combines independent DB/schema and HTTP evidence, but cannot authoritatively test application-level OIDC, tenant permissions or export rules without integration credentials. The API owner should add a distinct, protected dependency-ready route if operators need machine-readable application readiness; do not relabel `/healthz`.

Safe diagnostics:

```sh
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml ps --all
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml logs --no-color --tail=80 migrate postgres api web
```

Redact output before sharing. Never run `docker inspect` on containers to publish environment variables, `printenv`, `set -x`, or `docker compose config` without `--quiet` when it could expose config. No BYOK/provider keys or database URL belongs in logs. Redis is disposable, and Ollama is optional CPU-only; neither is part of authoritative recovery. Worker stays disabled until a real consumer, backlog metric and lease-recovery protocol are shipped.

## Integrator-only follow-ups (not edited here)

- Add `node --test deploy/tests/recovery.test.mjs` to an existing deployment CI job, and run its **full** Docker test with `RUN_SCOPEHATCH_DOCKER_RECOVERY=1` in a separate job with an available Docker daemon (avoid running fixtures on shared/customer hosts).
- Add a separately protected application-readiness endpoint and real signed OIDC + approval/export upgrade smoke; these require API/shared contracts and are explicitly outside this worker's file ownership.
- Update synthetic restore fixtures for Sprint 02 nonempty proposal metadata and any future new authoritative storage when the persistence PR is integrated.
