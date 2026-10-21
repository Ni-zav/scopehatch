# Scopehatch single-host deployment

**Status: scaffolding, NOT a verified end-to-end demo (2026-10-21).** The main branch did not yet contain the API, worker, web, persistence or migrations when this workstream began. No container boot, authentication workflow, image build, integration suite or real model call is claimed. Refer to [integration requirements](integration.md).

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
chmod 600 deploy/secrets/postgres_password
# Update OIDC_ISSUER, OIDC_AUDIENCE, OIDC_JWKS_URI in .env
```

Never commit `.env`, `deploy/secrets/`, backup dumps, customer text or credentials. The bridge reads Docker secrets into child-process environment; no DB password or provider key is interpolated into Compose YAML. A signed JWT with a configured trusted issuer/audience and **trusted membership records** is mandatory in both dev and prod; there is no magic tenant/role header.

### Infrastructure only (safe while app workstreams are missing)

```sh
docker compose --env-file .env -f deploy/compose.yaml config --quiet
docker compose --env-file .env -f deploy/compose.yaml up -d postgres
docker compose --env-file .env -f deploy/compose.yaml ps
```

This only starts PostgreSQL, not Scopehatch's business workflow. Docker must be installed locally to execute these commands.

### Production-style app (once integration dependencies are satisfied)

```sh
sh deploy/scripts/preflight.sh prod
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml up --build -d
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml ps
curl -fsS http://127.0.0.1:8080/_healthz
curl -fsS http://127.0.0.1:8080/healthz
```

Open `http://127.0.0.1:8080`. The first healthcheck is nginx only and the second is API liveness only; **neither demonstrates approval, exports, tenant isolation or readiness**. A genuine demo needs two verified identities and complete brief → scope → blockers/estimate → second-person review → revision-bound export → audit/evaluation evidence.

### Development mode

```sh
sh deploy/scripts/preflight.sh dev
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.dev.yaml up --build
```

Vite will serve `http://127.0.0.1:5173` and API `http://127.0.0.1:3000/healthz` **after their implementations exist**. Development uses rebuild-on-edit for now, not live source bind mounts. The web worker must add Vite proxy rules for `/v1` and `/healthz`; authentication is not disabled.

### Optional Redis

Add `--profile cache` to the Compose invocation and configure `REDIS_URL=redis://redis:6379` only when the API actually supports Redis. Do not treat it as a durable queue or budget ledger.

### Optional local Ollama, CPU-first

Set `SCOPEHATCH_INFERENCE_PROVIDER=ollama`, `SCOPEHATCH_INFERENCE_BASE_URL=http://ollama:11434`, `SCOPEHATCH_INFERENCE_MODEL=<installed-model>`. Run:

```sh
docker compose --env-file .env --profile local-inference -f deploy/compose.yaml -f deploy/compose.prod.yaml up -d postgres ollama
docker compose --env-file .env --profile local-inference -f deploy/compose.yaml exec ollama ollama pull <installed-model>
sh deploy/scripts/preflight.sh prod
docker compose --env-file .env --profile local-inference -f deploy/compose.yaml -f deploy/compose.prod.yaml up --build -d
```

Check model rights/resources separately. An `ollama list` health response proves daemon availability, not that the selected model exists, runs efficiently or passes evaluations.

### Optional hosted OpenAI-compatible BYOK

Set provider to `openai-compatible`, configure its allowlisted URL/model and write the key to `deploy/secrets/provider_api_key` (mode 0600). Do **not** put it in `.env` or logs. Add `-f deploy/compose.external-model.yaml` to the normal production invocation and call `sh deploy/scripts/preflight.sh prod external`. The application still must enforce tenant/provider eligibility, SSRF restrictions, authorization and budget reservations; a global key is illustrative for single-tenant demo only.

## Lifecycle

```sh
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml logs --tail=100 api worker migrate
docker compose --env-file .env -f deploy/compose.yaml -f deploy/compose.prod.yaml down
```

`down` retains named volumes. **Never use `down -v` for routine deploys.** For upgrades, back up and restore-test, check image and migration compatibility, then rebuild. Image rollback alone cannot reverse schema changes. In production pin audited image digests; floating tags in this prototype are not a supply-chain control.

See [backup/restore](backup-and-restore.md), [operations/observability](observability.md) and [integration requirements](integration.md).
