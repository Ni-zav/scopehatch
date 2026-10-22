#!/bin/sh
# Read-only pre/post upgrade gate. Never runs migrations or restarts application.
set -eu
case "${1:-}" in
  --help|-h)
    echo 'Usage: sh deploy/scripts/verify-upgrade.sh before|after'
    echo 'Read-only checks; operator controls backup, migration, rollout and rollback.'
    exit 0 ;;
  before|after) phase=$1 ;;
  *) echo 'Usage: sh deploy/scripts/verify-upgrade.sh before|after' >&2; exit 64 ;;
esac
[ "$#" -eq 1 ] || { echo 'Unexpected extra arguments' >&2; exit 64; }
cd "$(dirname "$0")/../.."
sh deploy/scripts/preflight.sh prod
command -v curl >/dev/null 2>&1 || { echo 'Missing curl for HTTP verification' >&2; exit 69; }
set -- --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml
docker compose "$@" config --quiet
# Exec uses local Unix socket inside PostgreSQL; no host DB port or URL.
docker compose "$@" exec -T postgres sh -ceu '
  pg_isready -q -U "$POSTGRES_USER" -d "$POSTGRES_DB"
  psql -X -q -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    -Atqc "SELECT CASE WHEN to_regclass('\''scopehatch.tenants'\'') IS NOT NULL
      AND to_regclass('\''scopehatch.projects'\'') IS NOT NULL
      AND to_regclass('\''scopehatch.reviews'\'') IS NOT NULL
      AND to_regclass('\''scopehatch.audit_events'\'') IS NOT NULL
      AND to_regclass('\''scopehatch.inference_reservations'\'') IS NOT NULL
      THEN '\''schema-present'\'' ELSE '\''schema-missing'\'' END" | grep -qx schema-present
'
printf 'PASS: PostgreSQL socket reachable and expected schema objects exist.\n'
if [ "$phase" = before ]; then
  echo 'Pre-upgrade read-only gate passed. Back up and restore-test before applying a candidate.'
  exit 0
fi
migration_id=$(docker compose "$@" ps -aq migrate)
[ -n "$migration_id" ] || { echo 'FAIL: migrate service container missing' >&2; exit 1; }
state=$(docker inspect --format '{{.State.Status}}:{{.State.ExitCode}}' "$migration_id")
[ "$state" = 'exited:0' ] || { echo 'FAIL: migrate service has not completed successfully' >&2; exit 1; }
published=$(docker compose "$@" port web 8080)
port=${published##*:}
case "$port" in ''|*[!0-9]*) echo 'FAIL: expected web port not published' >&2; exit 1 ;; esac
for endpoint in /_healthz /healthz; do
  curl --silent --show-error --fail --connect-timeout 3 --max-time 10 \
    --output /dev/null "http://127.0.0.1:$port$endpoint" ||
    { echo "FAIL: local web/API probe $endpoint" >&2; exit 1; }
done
echo 'PASS: migration exited 0, nginx and API liveness reachable via published web port.'
echo 'LIMIT: /healthz is liveness, not authenticated OIDC/tenant/DB workflow readiness.'
echo 'Complete signed OIDC, distinct-reviewer, exact-export and tenant smoke tests before cutover.'
