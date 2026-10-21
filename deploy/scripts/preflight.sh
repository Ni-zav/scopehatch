#!/bin/sh
# Run from any directory: sh deploy/scripts/preflight.sh prod|dev [external]
set -eu
mode=${1:-prod}
external=${2:-}
case "$mode" in prod|dev) ;; *) echo 'Usage: preflight.sh prod|dev [external]' >&2; exit 64 ;; esac
case "$external" in ''|external) ;; *) echo 'Optional second argument must be external' >&2; exit 64 ;; esac
cd "$(dirname "$0")/../.."
command -v docker >/dev/null 2>&1 || { echo 'Docker CLI not installed' >&2; exit 69; }
docker compose version >/dev/null 2>&1 || { echo 'Docker Compose v2 not installed' >&2; exit 69; }
test -f .env || { echo 'Missing .env (copy .env.example and configure identity)' >&2; exit 78; }
test -s deploy/secrets/postgres_password || { echo 'Missing/empty deploy/secrets/postgres_password' >&2; exit 78; }
test -s deploy/secrets/postgres_runtime_password || { echo 'Missing/empty deploy/secrets/postgres_runtime_password' >&2; exit 78; }
if [ "$external" = external ]; then
  test -s deploy/secrets/provider_api_key || { echo 'Missing/empty deploy/secrets/provider_api_key' >&2; exit 78; }
fi
for item in package-lock.json apps/api/package.json apps/web/package.json packages/persistence/package.json; do
  test -f "$item" || { echo "Integration dependency missing: $item" >&2; exit 78; }
done
if grep -q 'issuer.example.invalid' .env; then
  echo 'OIDC issuer is still a placeholder' >&2
  exit 78
fi
set -- -f deploy/compose.yaml -f "deploy/compose.$mode.yaml"
if [ "$external" = external ]; then set -- "$@" -f deploy/compose.external-model.yaml; fi
docker compose --env-file .env "$@" config --quiet
printf 'Compose syntax and baseline files verified (%s%s).\n' "$mode" "${external:+ + external}" >&2
printf 'Build/runtime integration and identity flows still require application tests.\n' >&2
