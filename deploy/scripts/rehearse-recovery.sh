#!/bin/sh
# Deterministic, Docker-only disposable PG backup/restore with real database assertions.
# NEVER connects to the Compose stack, local PG sockets, or any customer DATABASE_URL.
set -eu
umask 077
case "${1:-}" in
  --help|-h)
    echo 'Usage: sh deploy/scripts/rehearse-recovery.sh [--keep-report DIR]'
    echo 'Creates two disposable --network none PostgreSQL 17 containers. No customer data.'
    exit 0 ;;
  '' ) ;;
  --keep-report)
    [ "$#" -eq 2 ] && [ -d "$2" ] || { echo 'Existing report directory required' >&2; exit 64; }
    report_dir=$2 ;;
  * ) echo 'Unknown argument; use --help' >&2; exit 64 ;;
esac
[ "$#" -le 2 ] || { echo 'Unexpected extra arguments' >&2; exit 64; }
cd "$(dirname "$0")/../.."
command -v docker >/dev/null 2>&1 || { echo 'BLOCKED: Docker CLI unavailable' >&2; exit 69; }
docker info --format '{{.ServerVersion}}' >/dev/null 2>&1 || {
  echo 'BLOCKED: no accessible Docker daemon' >&2; exit 69;
}
# The rehearsal never references COMPOSE_PROJECT_NAME, POSTGRES_DB, or supplied URLs.
for file in db/migrations/001_initial.sql db/migrations/002_quote_integrity.sql \
  db/migrations/003_immutable_children_usage.sql db/migrations/004_identity_lookup.sql \
  db/migrations/005_inference_governance.sql db/seeds/001_studios.sql \
  db/seeds/002_inference_fixture.sql deploy/tests/recovery-fixture.sql \
  deploy/tests/recovery-integrity.sql; do
  [ -s "$file" ] || { echo "Missing source file: $file" >&2; exit 78; }
done
tmp=$(mktemp -d "${TMPDIR:-/tmp}/scopehatch-dr.XXXXXXXX")
source_id='' target_id=''
cleanup() {
  [ -z "$source_id" ] || docker rm -f "$source_id" >/dev/null 2>&1 || :
  [ -z "$target_id" ] || docker rm -f "$target_id" >/dev/null 2>&1 || :
  rm -rf -- "$tmp"
}
trap cleanup EXIT
tag=$(basename "$tmp")
start_pg() {
  # Trust authentication only inside an unconnected, --network none disposable container;
  # never use this option in Compose or production.
  docker run --detach --rm --network none --name "$tag-$1" \
    --label scopehatch.recovery-rehearsal=true \
    --security-opt no-new-privileges:true \
    -e POSTGRES_DB=scopehatch_dr -e POSTGRES_HOST_AUTH_METHOD=trust \
    postgres:17-bookworm
}
wait_pg() {
  container=$1
  i=0
  while [ "$i" -lt 45 ]; do
    if docker exec "$container" pg_isready -q -U postgres -d scopehatch_dr >/dev/null 2>&1; then return; fi
    i=$((i+1)); sleep 1
  done
  echo 'Disposable PostgreSQL did not become ready' >&2
  return 1
}
psql_file() {
  docker exec -i "$1" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d scopehatch_dr < "$2"
}
migrate() {
  for file in db/migrations/001_initial.sql db/migrations/002_quote_integrity.sql \
    db/migrations/003_immutable_children_usage.sql db/migrations/004_identity_lookup.sql \
    db/migrations/005_inference_governance.sql; do
    psql_file "$1" "$file" >/dev/null
  done
}
role_setup() {
  docker exec "$1" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d scopehatch_dr \
    -c 'DO $$ BEGIN
          IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = ''scopehatch_app'') THEN
            CREATE ROLE scopehatch_app NOLOGIN NOBYPASSRLS;
          END IF;
          IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = ''scopehatch_rehearsal_runtime'') THEN
            CREATE ROLE scopehatch_rehearsal_runtime LOGIN INHERIT NOSUPERUSER NOBYPASSRLS;
          END IF;
        END $$;' >/dev/null
  docker exec "$1" psql -X -q -v ON_ERROR_STOP=1 -U postgres -d scopehatch_dr \
    -c 'GRANT scopehatch_app TO scopehatch_rehearsal_runtime' >/dev/null
}
fingerprints() {
  c=$1
  list=$(docker exec "$c" psql -X -At -U postgres -d scopehatch_dr \
    -c "SELECT tablename FROM pg_tables WHERE schemaname='scopehatch' ORDER BY tablename")
  [ -n "$list" ] || { echo 'No Scopehatch tables found' >&2; return 1; }
  printf '%s\n' "$list" | while IFS= read -r table; do
    case "$table" in ''|*[!a-zA-Z0-9_]*)
      echo 'Unsafe schema table identifier' >&2; exit 1 ;; esac
    value=$(docker exec "$c" psql -X -At -F '|' -U postgres -d scopehatch_dr \
      -c "SELECT count(*),md5(coalesce(string_agg(to_jsonb(row_data)::text,E'\\n' ORDER BY to_jsonb(row_data)::text),'')) FROM scopehatch.\"$table\" row_data")
    printf '%s|%s\n' "$table" "$value"
  done
}
printf 'Starting disposable source PostgreSQL (no network or published ports).\n'
source_id=$(start_pg source)
wait_pg "$source_id"
migrate "$source_id"
role_setup "$source_id"
psql_file "$source_id" db/seeds/001_studios.sql >/dev/null
psql_file "$source_id" db/seeds/002_inference_fixture.sql >/dev/null
psql_file "$source_id" deploy/tests/recovery-fixture.sql >/dev/null
psql_file "$source_id" deploy/tests/recovery-integrity.sql >/dev/null
fingerprints "$source_id" > "$tmp/source.fingerprints"
dump_started=$(date +%s)
docker exec "$source_id" pg_dump -U postgres -d scopehatch_dr \
  --format=custom --no-owner > "$tmp/backup.dump"
[ -s "$tmp/backup.dump" ] || { echo 'Empty backup archive' >&2; exit 1; }
docker exec -i "$source_id" pg_restore --list < "$tmp/backup.dump" > /dev/null
dump_ended=$(date +%s)

printf 'Starting independent empty restore target (no network or published ports).\n'
target_id=$(start_pg target)
wait_pg "$target_id"
role_setup "$target_id" # pg_dump does not include cluster roles; policies/ACL reference them.
restore_started=$(date +%s)
docker exec -i "$target_id" pg_restore -U postgres -d scopehatch_dr \
  --exit-on-error --no-owner < "$tmp/backup.dump"
restore_ended=$(date +%s)
psql_file "$target_id" deploy/tests/recovery-integrity.sql >/dev/null
fingerprints "$target_id" > "$tmp/target.fingerprints"
if ! cmp -s "$tmp/source.fingerprints" "$tmp/target.fingerprints"; then
  echo 'FAIL: table content fingerprints differ after restore' >&2
  diff -u "$tmp/source.fingerprints" "$tmp/target.fingerprints" >&2 || :
  exit 1
fi
# Forward-only idempotent migration/restart rehearsal against the RESTORED disposable DB.
migrate "$target_id"
psql_file "$target_id" deploy/tests/recovery-integrity.sql >/dev/null
fingerprints "$target_id" > "$tmp/after-migration.fingerprints"
cmp -s "$tmp/source.fingerprints" "$tmp/after-migration.fingerprints" || {
  echo 'FAIL: rerunning migrations changed restored content' >&2; exit 1;
}
bytes=$(wc -c < "$tmp/backup.dump" | tr -d ' ')
printf 'PASS: source and restored dataset, tenant RLS, approval, audit, replay, holds, and migration rerun.\n'
printf 'Synthetic dump bytes=%s backup_seconds=%s restore_seconds=%s; NOT a measured production RTO/RPO.\n' \
  "$bytes" "$((dump_ended-dump_started))" "$((restore_ended-restore_started))"
if [ -n "${report_dir:-}" ]; then
  cp "$tmp/source.fingerprints" "$report_dir/recovery-fingerprints.txt"
  printf 'synthetic_dump_bytes=%s\nbackup_seconds=%s\nrestore_seconds=%s\n' \
    "$bytes" "$((dump_ended-dump_started))" "$((restore_ended-restore_started))" \
    > "$report_dir/recovery-results.txt"
  echo 'Written non-sensitive aggregate report (no raw customer data or dump).'
fi
