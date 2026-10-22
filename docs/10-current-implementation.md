# Actual implementation and CI evidence

**Point-in-time snapshot:** 2026-10-22, `main` [`0b8e259c4e7c6134b24550ff82e83011fcceff4b`](https://github.com/Ni-zav/scopehatch/commit/0b8e259c4e7c6134b24550ff82e83011fcceff4b). Check current main and CI again before making later claims. [PR #17](https://github.com/Ni-zav/scopehatch/pull/17) integrated Sprint 01, [PR #21](https://github.com/Ni-zav/scopehatch/pull/21) hardened main CI and [PR #22](https://github.com/Ni-zav/scopehatch/pull/22) merged the **Sprint 02 contract only**. Neither contract nor parallel worker PRs prove runtime features. Nothing here certifies a customer production install.

## Exact-SHA GitHub Actions evidence

| Recorded run/job | Result and exercised scope | NOT established |
| --- | --- | --- |
| [Core #39702122223](https://github.com/Ni-zav/scopehatch/actions/runs/39702122223) | **Success** on `0b8e259`; Node 22, `npm test` and `npm run demo` | External production services |
| [Integration #39702122224](https://github.com/Ni-zav/scopehatch/actions/runs/39702122224) | **Success** on same SHA, all three jobs below | General production readiness |
| `contracts` | `npm ci`; build/typecheck/unit/adversarial fixture eval; deployment static tests; fixture Chromium Playwright | Real model quality or external identity |
| `postgres-security` | PostgreSQL 17 migrations and restricted runtime login; RLS, approval/replay; Fastify/SDK/inference; two-actor Chromium via locally signed synthetic OIDC Authorization Code + PKCE | Third-party issuer and actual customer provisioning |
| `compose-smoke` | Compose preflight/images, PG migrations, API/web boot, liveness and runtime NOBYPASSRLS assertion | Authenticated real-studio first use, backup **restore**, security audit |

Jobs were inspected on the recorded [CI workflow](../.github/workflows/integration.yml); this documentation task has **not** itself run local Docker, database, browser or model tests. Intermediate integration-branch CI recorded **failures**, subsequently corrected before main passed; historical failure runs should not be hidden or confused with the final SHA.

## Code that exists

| Component / code reference | Implemented | Evidence boundary |
| --- | --- | --- |
| [`src/domain.mjs`](../src/domain.mjs), [domain tests](../test/domain.test.mjs), [workpack](../workpacks/brief-to-proposal/manifest.yaml) | Catalog-bound integer minor-unit estimates, blockers, revisions, distinct human review, Markdown proposal **draft** | Unit and integration tests, not signed customer quotes |
| [`apps/api/src/server.ts`](../apps/api/src/server.ts), [auth](../apps/api/src/auth.ts), [core](../apps/api/src/core.ts) | Sprint 01 protected REST routes, RS256/ES256 JWT/JWKS verification, membership-selected tenant/roles, POST idempotency, safe errors, audit | Synthetic-issuer integration; `/healthz` is only liveness |
| [`apps/api/src/postgres.ts`](../apps/api/src/postgres.ts), [`packages/persistence/`](../packages/persistence/index.mjs), [migrations through 005](../db/migrations/005_inference_governance.sql) | Transactional tenant isolation, immutability, catalog price checks, review/replay/audit, inference reservations | Real PostgreSQL CI; known SQL custom-GUC limitation |
| [`apps/web/`](../apps/web/src/App.vue), [PKCE](../apps/web/src/oidc.ts), [Playwright](../apps/web/e2e/workbench.spec.ts) | Standalone labeled fixture and API-only browser workbench; sign-in uses public PKCE and in-memory access token | Real OIDC/first-owner external configuration absent |
| [`packages/sdk/`](../packages/sdk/src/client.ts), [SDK tests](../packages/sdk/test/client.test.mjs) | Typed existing REST client, caller-managed credential/abort, explicit write keys, bounded read retries, typed failures | Mock tests and signed JWT/PG integration; no SDK-only authority |
| [`packages/extraction/`](../packages/extraction/index.mjs), [governance](../packages/governance/src/index.mjs), [inference](../apps/api/src/inference.ts), [evaluation harness](../tests/evaluations/README.md) | Validated suggestion evidence, tenant policy and durable held spend, deterministic non-model fixture, configured Ollama/OpenAI-compatible adapter | No recorded real-model benchmark or real billing reconciliation |
| [`deploy/`](../deploy/compose.yaml), [operator instructions](operations/README.md) | Single-host Docker Compose Postgres/API/web migrations, CPU-first optional cache/model, CI boot and health | No externally verified hosted deployment or isolated restore |

## Absent or externally unverified

- **Sprint 02 code on this main SHA:** owner-only `POST /v1/catalogs`; tenant-paginated `GET /v1/projects`; scope-bound proposal overview/assumptions/exclusions/commercial terms and descriptions; trusted offline first-owner CLI; new SDK/Vue support for these. They are **planned** in [the frozen Sprint 02 interface](../contracts/sprint-02-interface.md).
- **Real onboarding/identity:** no externally operated trustworthy OIDC issuer configuration and verified first owner `sub` tested as a deployed studio. Seed Studio A/B are synthetic. A signed CI test JWT is not an operational account.
- **Model validation:** optional provider adapter does not demonstrate approved real-model accuracy, prompt injection robustness against an actual model, latency or reported bill accuracy. The deterministic fixture's measured zero tokens is **not** a substitute for unknown provider usage. Unknown usage must keep the budget hold pending reconciliation.
- **Operational resilience:** no verified isolated backup/restoration, measured RTO/RPO, public-host TLS/secret rotation/security audit, functioning durable outbox consumer or customer deployment. Redis and GPU are optional, worker disabled until validated.
- **Residual data isolation risk:** [`db/README.md`](../db/README.md) warns that custom PostgreSQL transaction GUCs are writable through arbitrary SQL under the shared app role; RLS tests do **not** certify SQL-injection-proof isolation.
- **Commercial scope:** no documented paying customers, binding signed quotation, invoice/e-signature, email sending or hosted billing.

## Repeatable local commands versus CI results

On Node.js 22+ from root:

```sh
npm ci --no-audit --no-fund
npm run build
npm run typecheck
npm run test:unit
npm run test:eval
npm run demo
npx playwright install chromium
npm run test:browser
```

`npm test` aliases `test:unit`. Fixture Vue: `npm run dev --workspace @scopehatch/web` at http://localhost:4173. For **real disposable database** tests, supply secret-safe `TEST_PG_ADMIN_URL` and `TEST_PG_APP_URL` and run `npm run test:db`; absent variables cause skips, not a pass. The signed synthetic PostgreSQL browser flow is a separate [integration CI](../.github/workflows/integration.yml) job, not proven by fixture `test:browser`.

Self-host instructions: [operations](operations/README.md), [integration requirements](operations/integration.md), [backup/restore](operations/backup-and-restore.md). They demand external trusted OIDC and secure setup; a successful liveness probe is not an end-to-end approval check. Never restore over a live DB or issue `down -v` against retained production volumes.

Next verification: [Sprint 02 workstreams](12-sprint-02-workstreams.md) and [G01–G10 release gates](13-sprint-02-release-gates.md). Log actual candidate SHA, commands/outcomes, explicit skips, redacted artifacts and independently observed external identity/model/recovery proofs. A green older build or standalone PR is not release approval.
