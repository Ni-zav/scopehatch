# PostgreSQL backup and recovery runbook

PostgreSQL is authoritative for projects, catalogs, approvals, audit events and worker leases once the persistence package is integrated. Redis is disposable cache. Ollama's model volume can be re-pulled subject to model license and availability; include future file/object stores and tenant encryption keys in the backup plan.

## Disposable recovery rehearsal

Run `sh deploy/scripts/rehearse-recovery.sh` from the repository root. It tests synthetic PostgreSQL 17 dumps/restores in two isolated `--network none` containers; restores table fingerprints, RLS, immutable revisions, review/export eligibility, audit/idempotency and outstanding inference holds. See [the rehearsal and upgrade guide](recovery-rehearsal.md). This does not establish a real installation's RTO/RPO.

## Logical backup

Migration 008 stores a signing key in the private database schema.
A full dump includes this key and must receive equivalent protection.
Follow [key recovery and rotation](../security/transaction-context.md) before restarting a restored application.

Run from the repository root on an authenticated Docker host:

```sh
umask 077
mkdir -p deploy/backups
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml exec -T postgres \
  sh -ceu 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner' \
  > "deploy/backups/scopehatch-$(date -u +%Y%m%dT%H%M%SZ).dump"
# Confirm archive readability with a PostgreSQL 17 client:
pg_restore --list deploy/backups/<backup-name>.dump >/dev/null
```

If `pg_restore` is absent on host, use a version-compatible PostgreSQL client or dedicated ephemeral container. Encrypt backups and store them off-host with separately managed encryption keys. Verify retention, size and actual restore time. A completed `pg_dump` does **not** prove recovery. No measured RPO/RTO exists yet.

## Restore (destructive: rehearse first)

1. Check that the archive belongs to this installation and identify the schema/app version and tenant population. Preserve the failed volume for investigation and take an additional snapshot if possible. Rotate affected keys on security events.
2. Stop writers but leave PostgreSQL up:

```sh
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml stop api worker web
```

3. Restore into a **separate, empty recovery DB/volume** whenever possible. Precreate required PostgreSQL cluster roles on the isolated target (at minimum `scopehatch_app` as NOLOGIN/NOBYPASSRLS and the restricted runtime login): logical dumps do not contain cluster roles. Keep ACL grants in the archive and restoration (`--no-acl` must NOT be used without an independently verified regrant procedure). The example below targets a deliberately empty configured `POSTGRES_DB`, and fails if existing objects conflict:

```sh
cat deploy/backups/<backup-name>.dump | docker compose --env-file .env \
  -f deploy/compose.yaml -f deploy/compose.prod.yaml exec -T postgres \
  sh -ceu 'pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

Do **not** run `pg_restore --clean` into an active live database without an approved downtime and rollback plan. Recreating the empty target DB requires an isolated stack or explicit DB lifecycle procedure.

4. Verify schema/migrations, data counts/references, tenant A/B isolation, approver identity separation, immutable scope/catalog approval bindings, export and audit correctness, plus worker lease/replay status. Restart app only after verification.
5. Document elapsed restore time and data gap (actual RTO/RPO). Practice periodically; separately back up secret-manager material and any future object storage. Rolling back an image is not a schema rollback.

## Incident recovery

For suspected tenant leakage, restrict access immediately, preserve redacted evidence, rotate affected credentials, and meet incident/legal reporting duties. For corruption, preserve a forensic copy and restore to a new volume first; do not destroy the only replica with `down -v`. Verify ledger and audit correctness before announcing recovery.


## Release and recovery validation

Restore success is not proof of usable application recovery. On the isolated target, compare source/target table counts and all-column fingerprints, foreign keys, privileged versus restricted role permissions, RLS tenant A/B reads, immutable approved proposal terms, exact scope/catalog/estimate/reviewer binding, idempotent replay history, ordered audit, and outstanding inference holds. Check corruption handling (a damaged archive must fail), then independently verify signed OIDC and actual two-actor export through the application before cutover. Synthetic database fixtures are not substitute evidence for the customer's most recent real backup. Never run `down -v` or `pg_restore --clean` on a running installation. Schema migrations are forward-only; an image rollback alone cannot reverse them.
