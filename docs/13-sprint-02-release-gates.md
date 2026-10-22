# Sprint 02 release gates — measured first use, not feature checkboxes

**State:** release acceptance plan, not a release certification. Contract baseline: `main e8bbfca7d8826d50808feb19419801259984df6e` (2026-10-22), plus `contracts/sprint-02-interface.md` and `docs/12-sprint-02-workstreams.md`.

## 0. Evidence ledger at foundation baseline

| Evidence / gate | Observed on live main | What it does **not** establish |
|---|---|---|
| [Sprint 01 integration CI 39647403358](https://github.com/Ni-zav/scopehatch/actions/runs/39647403358) | **Passed**, same SHA as baseline: `contracts`, `postgres-security`, `compose-smoke` jobs. | Sprint 02 catalog/index/proposal/CLI behavior (not implemented); customer's infrastructure or production IdP. |
| [Core checks 39647403309](https://github.com/Ni-zav/scopehatch/actions/runs/39647403309) | **Passed** for baseline SHA. | Sprint 02 regression after migrations. |
| `apps/api/test/browser-oidc-e2e.ts` | Integration job exercised real Chromium + ephemeral test-issued, signed OIDC Authorization Code/PKCE with two actors, restricted PG and live API. | Integration to an external issuer on a real deployment, multi-tenant onboarding for a customer, renewal across commercial sessions. |
| `apps/api/test/inference.test.ts` and `db/migrations/005_inference_governance.sql` | Tenant governance/reservation tests executed in PostgreSQL CI; the adapter supports fixture and configured provider mode. | Real model extraction quality, provider outages/cost guarantees, unknown-cost reconciliation with a real bill. |
| `tests/evaluations` | Deterministic adversarial evaluation executes in root CI. | A real-model benchmark or statistically validated field performance. |
| `deploy/**` | Compose image build, migrate, API/web health, restricted role check executed in CI. | Rehearsed backup/restore, production TLS/secret rotation, fully configured owner login or outbox worker readiness. |

Prior issues [#18](https://github.com/Ni-zav/scopehatch/issues/18) and [#19](https://github.com/Ni-zav/scopehatch/issues/19) predate the final Sprint 01 integration; their concrete signed-browser and ledger tests are now in CI. Reconcile exact residual items by review, not an automatic "issue is open = untested" judgment. No external live-model result, restore result or complete Sprint 02 runtime test is claimed by this documentation PR.

## 1. Release levels and non-negotiable claims

- **Level A — developer/fixture demonstration**: deterministic fixture and test identities, explicit banner, no real model or production claims. CI green is necessary but insufficient for higher levels.
- **Level B — manual-first self-host beta**: real admin-created studio/owner with configured trustworthy external OIDC, actual catalog/list/proposal/review/export through mounted PG and browser/SDK, backup restored into an isolated volume, manual-only workflow. Model features **disabled or visibly unavailable** unless provider and policy/budget have passed their separate Level C tests. No public anonymous tenant registration. Not a formal security certification.
- **Level C — governed-model self-host beta**: all B gates plus a reachable approved Ollama or BYOK model, real evidence/cost/held-spend evaluation and failure safety on exactly the configured model/tenant. Do not label fixture execution as model quality.
- **Level D — external-user/public deployment**: independent security, privacy, incidents, backups, supply-chain, identity and operational review. No claim of D in Sprint 02 without actual reviewed evidence.

A useful core manual product can qualify at **B** even if inference is unavailable; however **C must fail/skip, not silently pass**, when a model or real provider usage cannot be tested. A disabled outbox worker must be explicitly listed as disabled, not a completed scheduler. Level B/C release notes list operational limitations prominently.

## 2. Gate matrix (blocking unless scoped as optional model gate)

### G01 — Reproducible code and contract

**Blocking A/B/C.** After integration, checkout the candidate SHA cleanly on Node 22+, install with `npm ci --no-audit --no-fund`, run `npm run build`, `npm run typecheck`, `npm run test:unit`, `npm run test:eval`. Also run `npm run test:db` using **disposable, restricted-role PostgreSQL** with `TEST_PG_ADMIN_URL` and `TEST_PG_APP_URL`; skipped DB tests are **not a pass**. Run `npm run test:browser` (fixture) and the signed OIDC/PG browser integration from CI. Run Compose static checks and full image boot with a clean volume. Record SHA, Node/Postgres/Docker/Compose versions, OS/architecture, commands, exit codes, failing test names, and workflow URLs. No invented benchmark or pass counts. A run against earlier SHA is stale evidence.

Checks: Sprint 01 endpoints remain valid; API, SDK and Vue use same JSON statuses, errors, role rules, normalized metadata and write keys. `GET /healthz` is **only liveness**, never the full workflow gate.

### G02 — Catalog ownership, versioning and replay

**Blocking B/C.** In a fresh tenant with no catalog: owner `GET /v1/catalogs` -> empty array; `POST /v1/catalogs` with `baseVersion:0` -> 201 version 1; same idempotency key/body -> identical 201 and one DB version; same key/different payload -> 409. Version 2 with `baseVersion:1` -> 201; two simultaneous owners using base 1 produce exactly one version 2 and a 409 stale response to the other. Operator and reviewer GET is permitted but POST is 403; **direct repository/SQL operator catalog INSERT is forbidden**. Tenant B cannot read A versions or use A's key. Changing catalog version makes previously ready quote/review no longer export eligible, without erasing history. Reject duplicate service, invalid currency, unsafe price and malformed version with 422. Zero price remains a valid user-set price, **not** an inference-usage "unknown=zero" assumption.

### G03 — Tenant project index and truthful status

**Blocking B/C.** `GET /v1/projects?limit=...&cursor=...` returns newest-first tenant-only page with `{items,nextCursor}`, validated opaque cursor and no brief text. Walk at least 3 pages with same-timestamp tie; each project appears once for stable dataset. Empty tenant has `items:[]` and null cursor. Reject foreign-tenant cursor/query workspace selector and invalid limits; test unauthorized users and missing JWT. Compare each summary `status` to project-detail `project.status` through `draft → blocked → ready → pending → approved` and after scope/catalog supersession (returns `draft` if latest estimate no longer binds). Status may not be client-computed differently by UI/SDK or persisted as mutable permission data.

### G04 — Immutable proposal and independent approval

**Blocking B/C.** Create new/legacy scope requests; old bodies still work and return normalized empty proposal/description. Add text-only descriptions, assumptions, exclusions and commercial terms and confirm new scope revision even when quantities/rates unchanged. Exact saved revision is displayed by GET and exported Markdown; estimate total uses immutable catalog integer-minor rates. Submission must be by authorized scope author, approval by **another** verified owner/reviewer with pending ready estimate; self-approval denied (403); forged scope/tenant catalog and stale quote denied (404/409); a late edit to **any** proposal term invalidates prior review/export. Verify SQL cannot change old metadata or append a child after review. Race old approval/export against new scope and catalog transaction; both cannot succeed as current after supersession. Restore must retain original text/revision/approval binding. Markdown/HTML preview must escape unsafe text, no outbound send.

### G05 — Trusted first-owner provisioning

**Blocking B/C.** On clean database, run host-only `scopehatch-admin tenant create --tenant-id <id> --owner-sub <verified-sub>` with secure admin DB material and non-placeholder configured issuer. Confirm one new tenant and one active membership (only `owner`), one durable transaction/audit-safe outcome. Repeat identically with no duplicate; conflicting owner/tenant must fail nonzero with no partial rows; malformed IDs/issuer/conflicting changes fail closed. Restricted app login and anonymous HTTP cannot create a tenant/member or elevate roles. Two tenant owners have no cross-workspace access. Login with real configured OIDC `sub` verifies exact membership; typoed subject gives 403, not a bootstrap shortcut. Never use synthetic Studio A/B subjects as a production identity source.

### G06 — Human and SDK end-to-end with real storage

**Blocking B/C.** From a newly provisioned real tenant and **two separately verified principals**, in running Compose or equivalent single-host stack:
1. Sign in via signed OIDC Authorization Code/PKCE using public SPA client with no client secret or bearer in localStorage; switch workspace only among verified memberships.
2. Owner creates catalog. Operator lists/creates project, pastes unmodified synthetic brief, creates scope + metadata, resolves blockers and receives deterministic estimate.
3. Owner/operator submits review; independent reviewer approves exact current scope/catalog/estimate; operator previews/exports only matching approved revision.
4. Audit timeline includes actor, revision, request ID and event; cross-tenant identity cannot discover another tenant's project/list/export.
5. SDK with injected credential provider repeats index/catalog/scoping and exact export over **the same Fastify+PG deployment**, not a parallel stub.
6. A text-only commercial-term edit makes old approval stale; reject forged/expired/wrong-issuer/audience JWTs, forged workspace hint, self-approval, mismatched Idempotency-Key and stale cursor.

Record browser screenshot/video/redacted request IDs and test evidence (no real JWT, briefs, API keys in artifacts). Repeat session expiry/sign-out failure path. Fixture Playwright tests are additional evidence, not substitutes for this external-IdP test at Level B/C. An integration test with isolated synthetic issuer is acceptable for CI but does not certify an operator's real IdP configuration.

### G07 — Privacy, tenant and concurrency

**Blocking B/C.** Test PostgreSQL RLS/composite foreign keys with real restricted non-superuser/NOBYPASSRLS app login: no cross-tenant read/write including catalogs, proposal text, audit, memberships, inference reservations. Test transactional SET LOCAL reset on reused pooled connections, public endpoints denying role headers, signed membership selection and idempotent concurrent commands. DB custom session GUCs are writable by arbitrary SQL under the app role (see `db/README.md`); parameterized SQL/no general query execution is required. Explicitly document residual SQL-injection impersonation threat, threat model and mitigation/independent security review before Level D. No logs/metrics/artifacts may include JWTs, tenant private briefs, BYOK keys, raw provider responses or admin credentials.

### G08 — Install, backup and **isolated restore**

**Blocking B/C.** Starting from documented clean Linux Docker + Compose v2 host, show: admin-only migration role and restricted runtime role, named PG volume, API/web boot behind localhost or trusted HTTPS reverse proxy, OIDC setup, offline tenant owner CLI and first-user catalog flow. Verify installed app works without GPU/Redis or live inference. Fail fast on missing config; secrets on disk with least privilege (not in images, Compose YAML, Git or CI logs). Do not assume healthcheck proves workflow.

Take timestamped logical backup `pg_dump -Fc` with metadata/version and verify archive readability via `pg_restore --list`. Restore into a **separate empty** DB/volume with compatible PG version and migration revision; never restore over live DB or use `down -v` on production data. Verify tenant counts/isolation, immutable approved proposal text/total, audit order, idempotency replay, review separation, and inference holds. Measure actual backup bytes, restore duration and any data gap; report measured RTO/RPO, not targets masquerading as results. Include failed-restore and rollback paths; secrets/encryption keys and any future object-store blobs need independent backup lifecycle. Redis optional/disposable. Worker remains disabled until a real consumer/lease/heartbeat test exists.

### G09 — Governed inference, optional for B; **blocking C**

**Blocking C only.** Fixture execution is Level A/B development evidence, not real model performance. For Level C configure exactly one reachable tenant-approved Ollama/OpenAI-compatible provider, allowlisted host/model/capability/residency, tenant-scoped key/policy and **durable** PostgreSQL budget. Use `POST /v1/projects/:id/suggestions` with verified operator, valid brief/cited catalog, idempotency, reservation **before** external dispatch. The response remains untrusted suggestion and cannot create price/catalog/review or send messages.

Run a real model on frozen held-out synthetic corpus (no private SVEIN/client content): exact model ID/revision/hash where available, runtime/provider version, decoding temperature/top_p/seed when supported, prompt/schema revision, adapter, environment CPU/GPU/memory, timeout, case set/checksum, attempt count, cost pricing snapshot and timestamps. Run at least one positive, missing-quantity/unknown-service abstention, Unicode UTF-16 evidence, injected approval/price override and malformed/oversized model response. Evaluate and report (numerator/denominator): field mapping, evidence span validity/attribution, unknown abstention, false commitment, schema pass, latency and usage status. Do not infer "good accuracy" from a small synthetic set; owner reviews an acceptance threshold based on actual results. All forbidden authority mutations MUST be rejected independent of model score. Do not put raw generated text or credentials in public artifacts.

Induce timeout/cancel/provider error/no-token-count response and concurrent same-key retries across processes. Unknown usage stays `unknown` and **cost hold persists** until verified reconciliation; measured zero usage is only allowed when the provider actually reports it (or trusted nonbillable fixture). Verify no double-dispatch/double-charge and fail closed for no eligible provider/budget. Missing model/credentials -> `NOT EVALUATED`, not `PASS`, and keep real-model feature disabled. Current evaluation CLI has an example live adapter (see `tests/evaluations/README.md`); existing historical reports do not count as current measurements.

### G10 — Review, docs and release integrity

**Blocking B/C.** Compare implemented endpoint/SDK/web contract to `contracts/sprint-02-interface.md` with real HTTP results; verify only the intended worker/integrator files changed. Review migration forward safety, no data loss, baseline compatibility, dependency lockfile/build, critical vulnerabilities, license notices, logs, start/stop/upgrade documentation, OIDC onboarding, rollback/incident handling and actual browser UX. Run CI on the **final candidate commit** and obtain independent maintainer/security review for tenant/inference boundaries. Merged docs alone are not proof of an operational feature. Link proof artifacts and record unresolved items and owner signoff.

## 3. Test commands and evidence handling

Run from a clean checked-out release candidate, not an already-built workspace:

```sh
node --version
npm ci --no-audit --no-fund
npm run build
npm run typecheck
npm run test:unit
npm run test:eval
# Requires real disposable Postgres URLs; never interpret skips as passes:
TEST_PG_ADMIN_URL=... TEST_PG_APP_URL=... npm run test:db
npm run test:browser
# For the release-integrated browser test, use the CI job's actual prerequisites:
node --experimental-transform-types apps/api/test/browser-oidc-e2e.ts
# Separate real-provider eval ONLY when configured/authorized:
EVAL_MODEL_URL=http://127.0.0.1:11434/v1/chat/completions EVAL_MODEL=<approved-local-model> \
  node tests/evaluations/runner.mjs --mode live \
  --adapter ./examples/evaluation/openai-compatible.mjs \
  --max-attempts 1 --timeout-ms 30000 --seed 7 \
  --output /tmp/scopehatch-live-eval.json
```

Avoid copying credentials into GitHub issues or logs: the `TEST_PG_*` URL placeholders are instructions, **not executable commands until safely populated**. For Docker instructions and the exact backup/restore sequence, see `docs/operations/README.md` and `docs/operations/backup-and-restore.md`. No fake external-model result or restore time may be populated by contract authors.

## 4. Required evidence record

For each gate, maintainer/integrator records one machine-readable or PR-table row with:

```json
{
  "gate":"G04",
  "status":"PASS",
  "scope":"Level B on candidate commit",
  "commitSha":"actual-40-character-sha",
  "environment":"versions + machine/DB/browser/provider",
  "commands":["literal executed commands, with secrets redacted"],
  "artifacts":["actual CI URL or redacted result file"],
  "observed":"specific assertions/test counts and failure conditions",
  "limitations":["uncovered paths or skipped checks"],
  "reviewedBy":"reviewer identity",
  "reviewedAt":"ISO-8601 time"
}
```

Allowed statuses: `PASS`, `FAIL`, `NOT_EVALUATED` (not run), `BLOCKED` (required dependency unavailable). A `SKIP` in test output maps to `NOT_EVALUATED`; **do not** promote to PASS. Only `PASS` gates count toward release. Any rebase/commit affecting gate behavior requires targeted rerun and fresh artifact link. A real-model gate may be marked `NOT_EVALUATED` for Level B, but must then be visibly disabled and cannot be marketed as a tested AI feature.

## 5. Go / no-go decision

| Release candidate | Required PASS | Must remain clearly disabled/unclaimed |
|---|---|---|
| **A: fixture demo** | G01 with explicit fixture labels; basic deterministic domain tests | Production identity, catalog/index/proposal/CLI before implemented, live model quality, disaster recovery. |
| **B: manual-first self-host beta** | G01–G08 and G10; G09 optional/not evaluated **only when live model is disabled** | Live model quality/cost, functioning async worker, hosted certification, external-user security approval. |
| **C: governed-model self-host beta** | G01–G10 all PASS, including real model and recovery | Commercial provider equivalence across models, public SaaS, worker unless separately tested. |
| **D: externally exposed service** | Separate completed independent audit, privacy/ops checks and reviewed evidence on top of C where inference offered | No inference of production certification from CI or Level B/C. |

Release PR must state exact feature toggles, excluded capabilities, tested OS/DB/browser/model, rollback approach and unresolved findings. Never merge/release only because HTTP 200, CI fixture green or docs say the functionality exists.
