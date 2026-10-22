# Scopehatch contributor and coding-agent contract

**Status (2026-10-22):** Sprint 01 is integrated at `main` `0b8e259` and passed [core](https://github.com/Ni-zav/scopehatch/actions/runs/39702122223) and [integration](https://github.com/Ni-zav/scopehatch/actions/runs/39702122224) CI. This **does not** establish production readiness. [Sprint 02's frozen interface](contracts/sprint-02-interface.md) is a target, not deployed behavior. Read [README](README.md), [current evidence](docs/10-current-implementation.md), [workflow](docs/03-workflow-and-contracts.md), [both interfaces](contracts/sprint-01-interface.md), [workstream ownership](docs/12-sprint-02-workstreams.md) and [release gates](docs/13-sprint-02-release-gates.md) before changing code.

## Mandatory invariants

- **Trusted server identity:** validate asymmetric JWT signature, issuer, audience, expiry/issued-at and subject; resolve actor, role and tenant from active membership storage. `X-Workspace-Id` can only select a verified membership. Body, browser, model and role-header claims grant nothing. Cross-tenant reads must not leak existence; insufficient-role writes are denied.
- **Deterministic money and approval:** only immutable catalog integer-minor rates and quantities set totals. Model suggestions cannot write fees, tax, catalog records, terms, approvals or reviewer identity. Unknown quantities, absent evidence, unsafe currency, overflow and stale revision must fail closed.
- **Exact immutable approvals:** intake, scope, catalog, estimate and human-authored terms must remain bound. New scope/catalog/term versions invalidate current approval eligibility; a different authorized verified reviewer must approve. Export is a human-reviewed Markdown **draft**, not a signed quotation or an auto-send.
- **Durable effect safety:** every POST has an `Idempotency-Key`; same tenant/key/request replays the original result without duplicate effects; mismatched actor, operation or payload conflicts. Writes, audit and replay records must be atomic. Never blindly retry unsafe POSTs.
- **Inference boundary:** validate response schema and source spans; gate provider by tenant model policy/allowlist/budget and reserve before dispatch. Missing usage remains `unknown` with hold retained until verified reconciliation; never invent zero tokens/cost or a model benchmark.
- **Least privilege:** restricted PostgreSQL (`NOBYPASSRLS`), composite tenant references, scoped transaction context, parameterized SQL and negative RLS/tenant tests. [DB threat note](db/README.md): custom session GUCs remain SQL-writable under the shared login; arbitrary SQL execution could impersonate a membership. Do not market tenant isolation as injection-proof without a separate security review.
- **No secrets or side effects:** never commit private customer/SVEIN data, keys, JWTs, private DB connections, backup dumps or unredacted traces. No unauthenticated owner bootstrap, production fixture seeds, public deployment, destructive migration/restore, arbitrary plugin/workpack execution or auto-email. Private vulnerabilities follow [SECURITY.md](SECURITY.md).

## Working in parallel

1. Fetch latest `main`, open PRs and exact-SHA CI; inspect actual code, not worker summaries. Use **one new branch and PR per task**; never write directly to `main` or self-merge.
2. Obey the task's **exclusive ownership** and the [Sprint 02 ownership plan](docs/12-sprint-02-workstreams.md). Integrator owns shared contracts, root lockfiles, CI and cross-workstream adapters. When blocked by a foreign path, record a **PROPOSED CONTRACT / INTEGRATION CHANGE**, not an unauthorized edit.
3. Preserve Sprint 01 API compatibility and implement only the agreed Sprint 02 wire types/routes. A mocked endpoint or updated interface is not an operational feature.
4. Add positive/negative tests: cross-tenant reads and writes, invalid signature/member/roles, catalog overflow, injection, stale revisions/terms, independent approval, idempotent replay/conflict, race and timeout/unknown usage as applicable.
5. Report exact executed checks (passes, failures, **skips**), untested gates, environment, files and head SHA in the PR. Do not fabricate benchmarks/screenshots or treat CI on a previous SHA as current proof.

## Commands and evidence

Node.js 22+ from root:

```sh
npm ci --no-audit --no-fund
npm run build
npm run typecheck
npm run test:unit
npm run test:eval
npm run demo
```

Fixture browser: `npx playwright install chromium` then `npm run test:browser`. Real DB checks: securely set `TEST_PG_ADMIN_URL` and `TEST_PG_APP_URL` to an isolated **disposable** PostgreSQL instance, then `npm run test:db`. Without URLs, skipped tests are not DB passes. [Integration CI](.github/workflows/integration.yml) also tests signed synthetic OIDC/PKCE against restricted PG, API/SDK/inference adapters and Compose. Never relabel that fixture issuer as externally configured production identity.

## Scope and design history

The [original five-day plan](docs/06-implementation-plan.md) is historical. Actual code lives in `src/domain.mjs`, `apps/api`, `apps/web`, `db`, `packages/persistence`, `packages/extraction`, `packages/governance`, `packages/sdk`, `deploy` and `tests/evaluations`. No general CRM, hosted billing, arbitrary agent/scheduler, GPU/Kubernetes requirement, automatic sending or purported ready outbox worker in Sprint 02. Redis and real inference remain optional and separately gated. Honor [LICENSE](LICENSE).
