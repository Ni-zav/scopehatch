# Scopehatch single-host deployment

**Status (integration branch, 2026-10-21):** Docker images, migrations, restricted PostgreSQL runtime login, API and web HTTP health, signed Fastify/PostgreSQL unit-integration flow, and fixture Playwright desktop/mobile tests are verified in [integration CI](https://github.com/Ni-zav/scopehatch/actions/workflows/integration.yml). **Not a production release**: real browser OIDC provider credentials and the durable governed-inference ledger are not integrated, and the outbox worker remains disabled by default. Main remains unchanged until release gates pass.

This stack targets a Linux single host with Docker Engine + Docker Compose v2. Kubernetes, GPU and Redis are NOT prerequisites. All commands start at the repository root.

## Layout and protection

- PostgreSQL 17 is authoritative, on the Docker internal `backend` network. `postgres_data` persists projects, approvals and audit records after DB integration. **No host DB port.**
- `migrate` waits for healthy PostgreSQL; API and worker wait for successful migration completion.
- API and worker run as UID 1000, with no Linux capabilities and read-only filesystems in production. They can use a controlled `/tmp` tmpfs.
- Vue builds into an unprivileged nginx container. nginx serves the SPA and proxies `/v1/` and `/healthz` to API. Only web is published, default host binding `127.0.0.1:8080`.
- Redis is optional (`--profile cache`), ephemeral/memory-limited and **never authoritative** for ledger, jobs or approvals.
- Ollama is optional (`--profile local-inference`), CPU capable, with a persistent model volume and **no host port**. Its upstream image's default user still needs hardening review.
- Private `backend`, app/web `frontend`, API/worker `egress` networks separate data traffic from public routes. Docker networks alone do not enforce tenant isolation.
- The operator supplies HTTPS reverse proxy, firewall, valid OIDC identity/JWKS and secure secret storage before any Internet access.

## Prepare configuration

```sh
cp .env.example .env
umask 077
mkdir -p deploy/secrets
openssl rand -base64 48 > deploy/secrets/postgres_password
openssl rand -base64 48 > deploy/secrets/postgres_runtime_password
# Containers run as UID/GID 1000; file-backed Compose secrets must be readable to that UID.
# Do not make these files world-readable.
sudo chown 1000:1000 deploy/secrets/postgres_password deploy/secrets/postgres_runtime_password
sudo chmod 0400 deploy/secrets/postgres_password deploy/secrets/postgres_runtime_password
# Configure the actual OIDC_ISSUER, OIDC_AUDIENCE, OIDC_JWKS_URI,
# and public PKCE VITE_OIDC_CLIENT_ID / AUTHORIZATION_ENDPOINT / TOKEN_ENDPOINT in .env.
```

Never commit `.env`, `deploy/secrets/`, backup dumps, customer text or credentials. The bridge reads Docker secrets into child-process environment; no DB password or provider key is interpolated into Compose YAML. A signed JWT with a configured trusted issuer/audience and **trusted membership records** is mandatory in both dev and prod; there is no magic tenant/role header.

### Infrastructure only (safe while app workstreams are missing)

```sh
docker compose --env-file .env -f deploy/compose.yaml config --quiet
docker compose --env-file .env -f deploy/compose.yaml up -d postgres
docker compose --env-file .env -f deploy/compose.yaml ps
```

This only starts PostgreSQL, not Scopehatch's business workflow. Docker must be installed locally to execute these commands.

### Single-host manual workflow (verified Compose boot, external OIDC setup required)

```sh
sh deploy/scripts/preflight.sh prod
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml up --build -d --wait
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml ps
curl -fsS http://127.0.0.1:8080/_healthz
curl -fsS http://127.0.0.1:8080/healthz
```

Open `http://127.0.0.1:8080`. The first healthcheck is nginx only and the second is API liveness only; **neither demonstrates approval, exports, tenant isolation or readiness**. For real login, configure your identity provider's public PKCE client to redirect to the deployed web URL and allow token endpoint CORS. Create active database memberships whose `principal_id` matches the **verified JWT subject**. Two distinct identities are required to test independent approval. For deterministic synthetic Studio A/B fixtures only, after initial migrations and before using the fixtures, execute: `docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml exec -T postgres psql -U scopehatch_admin -d scopehatch < db/seeds/001_studios.sql`. Do not apply synthetic users to a real studio. A successful healthcheck is not proof of authenticated browser login.

### Development mode

```sh
sh deploy/scripts/preflight.sh dev
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.dev.yaml up --build
```

Vite serves `http://127.0.0.1:5173`, forwarding `/v1` and `/healthz` to the API. The `dev:api` web script disables the standalone fixture; verified external OIDC login is required. Local fixture development remains an isolated, explicitly labeled mode.

### Optional Redis

Add `--profile cache` to the Compose invocation and configure `REDIS_URL=redis://redis:6379` only when the API actually supports Redis. Do not treat it as a durable queue or budget ledger.

### Optional local Ollama infrastructure (inference API still gated)

Set `SCOPEHATCH_INFERENCE_PROVIDER=ollama`, `SCOPEHATCH_INFERENCE_BASE_URL=http://ollama:11434`, `SCOPEHATCH_INFERENCE_MODEL=<installed-model>`. Run:

```sh
docker compose --env-file .env --profile local-inference -f deploy/compose.yaml -f deploy/compose.prod.yaml up -d postgres ollama
docker compose --env-file .env --profile local-inference -f deploy/compose.yaml exec ollama ollama pull <installed-model>
sh deploy/scripts/preflight.sh prod
docker compose --env-file .env --profile local-inference -f deploy/compose.yaml -f deploy/compose.prod.yaml up --build -d
```

Check model rights/resources separately. An `ollama list` health response proves daemon availability, not that the selected model exists, runs efficiently or passes evaluations.

### Optional hosted OpenAI-compatible BYOK

Set provider to `openai-compatible`, configure its allowlisted URL/model and write the key to `deploy/secrets/provider_api_key` (mode 0600). Do **not** put it in `.env` or logs. Add `-f deploy/compose.external-model.yaml` to the normal production invocation and call `sh deploy/scripts/preflight.sh prod external`. The provider secret can be supplied to the runtime, but **the live suggestions endpoint remains unavailable** until tenant allowlists and PostgreSQL-backed budget reservations are implemented and tested. Never interpret this configuration alone as enabling governed inference.

## Lifecycle

```sh
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml logs --tail=100 api worker migrate
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml down
```

`down` retains named volumes. **Never use `down -v` for routine deploys.** For upgrades, back up and restore-test, check image and migration compatibility, then rebuild. Image rollback alone cannot reverse schema changes. In production pin audited image digests; floating tags in this prototype are not a supply-chain control.

See [backup/restore](backup-and-restore.md), [operations/observability](observability.md) and [integration requirements](integration.md).
