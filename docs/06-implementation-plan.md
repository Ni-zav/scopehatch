# Sprint 01 history and Sprint 02 execution gates

The original “five prototype days” were a **planning sequence, not a deadline or production promise**. Actual build evidence is [recorded here](10-current-implementation.md). The [Sprint 02 frozen interface](../contracts/sprint-02-interface.md) and [gate matrix](13-sprint-02-release-gates.md) govern the next planned integration, not completed features.

## Historical prototype plan, reconciled with main (22 October 2026)

| Original phase | Original goal | Verified or qualified outcome |
| --- | --- | --- |
| Day 0–1 | Contracts, domain, pricing, approval tests | Domain/kernel and fixtures implemented, tested |
| Day 2 | Fastify, PostgreSQL, verified auth, Vue | Integrated; disposable restricted PostgreSQL and synthetic OIDC/PKCE Chromium CI passed |
| Day 3 | Extraction and governed provider/budget | Integrated fixture suggestion and optional provider adapter; **no real-model benchmark** |
| Day 4 | Evaluation, async jobs and traces | Synthetic adversarial eval integrated; actual outbox worker **disabled** pending consumer/lease validation |
| Day 5 | Compose, CI, docs, demo | Compose images/boot/health and CI passed; external IdP install and isolated restore **unverified** |

Traceability: [Sprint 01 integration PR #17](https://github.com/Ni-zav/scopehatch/pull/17), [CI gate PR #21](https://github.com/Ni-zav/scopehatch/pull/21), and [Sprint 02 **contract** PR #22](https://github.com/Ni-zav/scopehatch/pull/22). Latest main `0b8e259` passed [core CI](https://github.com/Ni-zav/scopehatch/actions/runs/39702122223) and [three integration jobs](https://github.com/Ni-zav/scopehatch/actions/runs/39702122224). Earlier intermediate integration branches had **failed** runs before the final fix; neither erase them nor infer that final main failed.

## Planned Sprint 02 sequence

| Stage | Target | Release-blocking proof |
| --- | --- | --- |
| Foundation | Frozen additive wire contract and exclusive workstreams | Contract merge is **not** endpoint implementation |
| DB + admin | Owner-only versioned catalog CAS, tenant list/status query, immutable proposal text, host-only first-owner provisioning | PG role/RLS, concurrency/replay, migration/backwards compatibility, trusted-subject setup |
| API + kernel | Bind protected new HTTP requests to authoritative storage; preserve existing routes | Negative 401/403/404/409/422, stale terms/quote/approval and exact export |
| SDK + Vue | Project index, owner catalog authoring, editable proposal metadata; server-authoritative states | Live SDK→API→PG and signed PKCE browser journey; mocks labeled separately |
| Operations | Reproducible CPU-only install, safe upgrades and **isolated restore** | Verified restored tenants/approvals/audit/ledger, measured time and nonproduction safeguards |
| Evaluation | Optional held-out actual Ollama/BYOK model, transparent settings and outcomes | Real calls with tracked metrics and missing-usage handling; never required for offline CI |
| Integrator | Reconcile shared adapters, root CI, regression and final candidate | All applicable [G01–G10 gates](13-sprint-02-release-gates.md) on **exact final commit** and independent review |

Merge vetted DB/admin before API integration, then SDK/web; evaluation and operations can be developed separately but not used as proof of an untested integrated path. Workers must obey [exclusive ownership](12-sprint-02-workstreams.md) and open nonmerged PRs. An incomplete capability is *planned*, not silently “done” because a workstream branch exists.

## Verification commands (root, Node 22+)

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

For disposable **real** PostgreSQL with required restricted runtime role, securely configure `TEST_PG_ADMIN_URL` and `TEST_PG_APP_URL` then execute `npm run test:db`. Missing variables produce skipped tests, **not passing database tests**. Full browser signed synthetic PKCE, API/SDK/inference/PG and Compose runs are specified in [integration CI](../.github/workflows/integration.yml); externally configured OIDC and [isolated backup/restore](operations/backup-and-restore.md) require separate proof.

The release record must include candidate SHA, versions, executed commands, exact pass/fail/skip results, linked artifacts, human review and limitations. [G01–G10](13-sprint-02-release-gates.md) distinguish fixture demo (A), manual-first self-host beta (B), provider-evaluated beta (C) and separately audited public deployment (D). No green CI from an earlier SHA is a release certification.

**P0:** trusted manual-first owner → catalog → project → immutable scoped proposal → independent review → export, with recovery. **P1:** ingestion, observability and optional agent surfaces. **P2:** hosted billing, GPU/Helm/Kubernetes, email automation, generalized CRM/workflow engine. Never relax security, approval, idempotency or unknown-usage holds for a timeline.
