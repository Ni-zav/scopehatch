# Sprint 02 parallel workstreams — owners, dependencies and integration decisions

**State:** coordination plan, not implemented features. Baseline `main` commit `e8bbfca7d8826d50808feb19419801259984df6e` (2026-10-22), `contracts/sprint-02-interface.md`. No edits outside these three Sprint 02 contract documents in the foundation PR.

## 1. Baseline and priority

Sprint 01 integration **was merged** as PR [#17](https://github.com/Ni-zav/scopehatch/pull/17). Latest matching main GitHub Actions: [integration run 39647403358](https://github.com/Ni-zav/scopehatch/actions/runs/39647403358) (contracts/postgres-security/compose-smoke passed) and [core run 39647403309](https://github.com/Ni-zav/scopehatch/actions/runs/39647403309) (success). The former executed a synthetic signed OIDC Authorization Code + PKCE **real Chromium browser** flow against restricted PostgreSQL, plus inference fixture/concurrency tests. It **did not** exercise an independently hosted commercial IdP, a configured live paid/local model, verified backup restoration or production customer deployment. Those are distinct gates.

Caution: original Sprint 01 worker PRs #9–#16 remain open even though their code was integrated via #17; they are **not fresh unmerged Sprint 02 features**. Issues [#18](https://github.com/Ni-zav/scopehatch/issues/18) and [#19](https://github.com/Ni-zav/scopehatch/issues/19) were drafted as release blockers before #17 integration. Reconcile their checklists against the final merged test logs; do not assume the issue state proves the gate is untested or that a passing fixture proves external readiness. Existing docs `README.md`, `AGENTS.md` and `docs/10-current-implementation.md` still contain bootstrap-era status text, not the live module inventory.

**Sprint 02 goal:** ship a coherent, honest first-use path: protected provisioner creates studio/owner → owner publishes rate catalog → owner/operator finds or creates project → editor adds evidence-backed scope and proposal text → deterministic estimate → distinct reviewer approves exact revision → export; with reproducible self-host/restore, SDK parity and model-evaluation evidence. No general workflow engine, hosted billing, arbitrary plugin runtime, auto-sending or mandatory GPU/Redis.

## 2. Worker protocol

1. Each worker starts **after foundation contract integration approval** from latest `main`, fetches open PRs/issues and contract, uses its own `feat/s02-*` branch, opens one PR to `main`; no self-merging. Never branch from another worker's unmerged PR unless integrator explicitly changes the dependency schedule.
2. Hard-exclusive paths below: including tests under those paths. No worker edits root `package.json`, `package-lock.json`, `AGENTS.md`, `README.md`, `src/domain.mjs`, `contracts/**`, `docs/12*`, `docs/13*` or `.github/workflows/**`. Only the integrator owns cross-cutting/root changes and contract amendments. If a needed fix crosses paths, file a **PROPOSED CONTRACT / INTEGRATION CHANGE** in PR and implement a port/mock adapter locally.
3. Implement against **exact** `contracts/sprint-02-interface.md` request/response/error/role shapes. The API and DB have separate internal interfaces; module tests may use explicit mock boundaries, never claim complete integrated behavior from mocks.
4. New writes require atomic idempotency; forward-only migrations; independent verified review and no model-priced terms; model cost unknown must remain unknown with durable hold. Keep restricted DB login and RLS protections.
5. Each worker records tests **actually executed** (commands and pass/fail/skip), behavior not tested, files modified, PR dependencies, migration and security implications. No real client/SVEIN data or credentials in fixtures. CI success on a standalone branch is not a release signoff.

## 3. Wave 1: parallel workers (once foundation approved)

Each row owns **only** its paths; all unlisted files remain integrator-owned. Suggested branches are distinct. Cross-worker dependencies are *contract-level*, not a license to modify another worker's code.

| Worker / branch | Exclusive owned paths | Deliverable, tests and integration dependencies |
|---|---|---|
| **DB** `feat/s02-db-revisions` | `db/**`, `packages/persistence/**` | Forward migration(s) after 005: owner-only catalog writes at SQL boundary, CAS baseVersion, normalized immutable proposal/line descriptions, project keyset index/list with DB-derived statuses. Concurrency/RLS, metadata immutability, replay, migration/old-row and stale-export PG tests. Existing API contract remains an adapter; expose scoped methods with documented shapes. |
| **API** `feat/s02-api-extensions` | `apps/api/**` | Add `POST /v1/catalogs` and `GET /v1/projects`; extend scope request/response and approved export metadata without breaking existing endpoints. Enforce role/selector/schema/error handling, status/list/export consistency; injected DB fake and HTTP tests until DB PR integrated. Do not weaken signed JWT or suggestion gates. Depends on DB port shape defined by shared contract; write adapter to existing port or note integrator bridge. |
| **WEB** `feat/s02-workbench-navigation` | `apps/web/**` | Owner-only first-run catalog editor with CAS conflict handling; paginated project list; faithful status/dirty state; proposal fields; revision invalidation and exact approved preview; accessibility/desktop-mobile/fixture and mocked HTTP tests. No new privilege path; 403 handled server-side. Can start with mock API. |
| **SDK** `feat/s02-sdk-parity` | `packages/sdk/**` | Type `CatalogCreate`, `ProjectPage`, `ProposalMetadata`; implement `createCatalog` and `listProjects`; preserve old method calls and forward optional metadata; typed error/cursor/replay/timeout tests and mock example. Public SDK never exposes CLI tenant bootstrap. |
| **ADMIN** `feat/s02-admin-provisioner` | `tools/admin/**` | Host-only least-privilege operational wrapper around protected provisioning connection; `tenant create`, `--dry-run` and deterministic exits; atomic tenant+initial owner, identical rerun, mismatch denial, issuer guard. Tests with disposable PostgreSQL and negative roles. No root script or Compose changes; integrator wires entrypoint/install guide later. |
| **EVAL** `feat/s02-real-model-evaluation` | `tests/evaluations/**`, `examples/evaluation/**` | Improve repeatable held-out synthetic prompt/evidence/abstention tests, live local/BYOK adapter reporting and real API workflow adapter. Mark fixture vs real model explicitly; record provider/model revision, parameters, corpus hash, measured usage/latency, redacted outcomes. No secrets/raw prompts in reports. Do not announce live scores without live execution. |
| **OPS** `feat/s02-install-restore` | `deploy/**`, `docs/operations/**` | Owner-first install/first-run (external trusted IdP + offline CLI) and **isolated restore rehearsal** with DB integrity/tenancy/approvals; clear worker-disabled/optional-model state; Compose reliability preflight, backup encryption guidance, CPU-first resource minimum and logs/exit status. Needs CLI contract only, not CLI source edits. |

Optional **AUDIT** session: strictly read-only security review across all PRs; reports exact file/line/scenario to integrator. It owns **no** code paths, branches or merges.

**Parallel safety:** DB and ADMIN cannot alter each other's files; ADMIN uses a documented DB admin operation / test-local schema and must not copy SQL into production web code. API cannot rewrite migrations; web cannot redefine API JSON; SDK cannot create alternative business invariants; OPS cannot "solve" absent bootstrap by adding public registration. Any incompatibility is an integration issue.

## 4. Wave 2: integration and proof (NOT parallel mutable ownership)

**Integrator branch:** `integrate/s02-first-use`. Integrator exclusively owns `package.json`, root lockfile, `.github/workflows/**`, existing `src/domain.mjs` (only if a minimal domain change is needed), `tests/integration/**` (new), shared adapters and coordination updates. May edit a worker-owned file **only after** owning PR is merged, with explicit reasoning and regression tests, avoiding concurrent branch edits.

Recommended order:

1. Approve/finalize Sprint 02 contract choices below and merge **this documentation-only foundation PR**. No worker implementation should infer "implemented" from the contract.
2. Merge **DB** (forward migration + direct DB authorization tests) and **ADMIN** (trusted owner provisioner) after checking their interfaces/transaction lock orders. Then **API**, binding its injected ports to real DB and reconciling serialization/idempotency with membership checks. Run PostgreSQL tenant, catalog and status tests on a disposable restricted-role database.
3. Merge **SDK**, **WEB** once API contract is stable. Run typed SDK → live Fastify → restricted Postgres and browser PKCE → catalog → project list → proposal revision → independent approval/export/audit. Check exact enum and normalized fields through both clients.
4. Merge **EVAL** and **OPS** independently when their changes are non-conflicting; wire root CI, first-run CLI image paths, docs, real model (if configured), and isolated restore drills. Do not ship online until evidence in `docs/13-sprint-02-release-gates.md` is complete.
5. Recheck open PRs, unresolved comments, migration order, release gates, known issues and exact target SHA. A green CI run tied to an earlier head is not sufficient. No automatic merge of pre-integration Sprint 01 feature branches.

At every step, integrator owns the end-to-end compatibility layer, source-of-truth status derivation, and domain/DB invariant reconciliation. Prefer fixing API ports rather than introducing a parallel persistence model. If code change in `src/domain.mjs` is essential, prove the old domain tests still pass unchanged.

## 5. Precise contracts across workers

- **Catalog creation:** API accepts `{baseVersion,currency,services}`; DB locks tenant, checks expected latest catalog, validates full replacement, persists version+services+audit+idempotency. Owner-only enforced in DB and API. SDK/Web use same CAS version. Publishing even an identical catalog supersedes old approval eligibility.
- **Listing:** DB derives current status as `draft|blocked|ready|pending|approved`, uses tenant+`created_at DESC,id DESC` stable cursor; API exposes `{items,nextCursor}`, SDK/Web navigate it. No list-level client brief content, no client tenant filter, no status-only fake local list.
- **Proposal:** API accepts optional metadata and line descriptions; DB stores them *within immutable scope revision*, domain computes money only from catalog/quantity; DB review/export checks freshness; Web/SDK pass metadata intact. Any text-only term change invalidates approval, re-estimation and separate review required.
- **Provisioning:** ADMIN owns CLI but DB remains the owner of schema/auth constraints. CLI uses separate provisioning DB connection and verified issuer subject, transactional tenant/initial owner, no registration endpoint. Integrator documents safe host invocation; web offers sign-in only.
- **Evaluation/ops:** EVAL proves local model facts only on real provider execution; OPS proves install/restore only by performing it. Neither can substitute fixtures/healthchecks for functioning approval or spend accounting.

## 6. Decisions requiring explicit integration approval

| Decision | Proposal | Tradeoff / affected workers |
|---|---|---|
| **D1. Catalog writer role** | Owner **only**, including DB trigger/persistence path (current direct DB admits operator). | Tightens permissions; DB/API/WEB/SDK tests must agree. |
| **D2. Catalog optimistic concurrency** | Required `baseVersion` (0 for first version) and complete version replacement; reject stale with `409 STALE_CATALOG_VERSION`. | Prevents lost updates; UI must preserve version on save. |
| **D3. Status encoding** | Preserve DB vocabulary `draft/blocked/ready/pending/approved`, derive from current quote binding. | Ports/SDK currently type project.status as draft-only or arbitrary string; avoid new duplicate "pending_review" enum. |
| **D4. Project pagination** | Tenant-bound keyset cursor ordered newest-first (`created_at,id`), default 20 max 100, no status filtering yet. | Efficient listing and deterministic concurrency semantics, no snapshot claim. |
| **D5. Proposal storage** | Optional proposal object `{overview,assumptions,exclusions,commercialTerms}` and optional per-line `clientDescription`; normalize empty legacy data, new scope revision on edits. | Human-authored commercial text requires reviewer scrutiny; no separate mutable proposal table or rate override. |
| **D6. Provisioning identity** | CLI-only administrative first tenant and active owner by trusted configured OIDC `sub`; initial roles `['owner']`. | Host operator needs admin DB credential, not app login; no email-based role inference or public registration. |
| **D7. Real-model release evidence** | A recorded real Ollama or tenant-approved BYOK evaluation separate from deterministic CI. No required paid model for manual-only self-host deployment; do not advertise model quality if skipped. | Offline CI remains reproducible; product labels capability according to proven deployment. |
| **D8. Worker posture** | Nonfunctional outbox worker stays disabled; manual synchronous core path can qualify as first-use release after its gates. | Avoids falsely advertising background execution; later worker work requires its own gate. |

Integrator approval should be captured in the foundation PR review or a narrowly scoped follow-up contract PR **before dependent runtime PRs merge**. If rejected, amend the contract centrally; workers must not fork the wire format.

## 7. Worker PR checklist (copy into every PR)

- Branch based on up-to-date approved `main`, only exclusive owned paths changed; no collision with current PR.
- Crosswalk each touched endpoint/method/schema to Sprint 02 section and enumerate intentional backward-compatible additions.
- List test commands, actual outputs, skipped/blocked tests, and live DB/model/browser evidence separately.
- Show owner/reviewer and tenant A/B denial, idempotency replay/conflict, stale catalog/scope/terms export and restoration/inference budget boundaries where relevant.
- Declare remaining ports/integrator adaptations; **do not merge** worker PR or claim self-host production readiness.
