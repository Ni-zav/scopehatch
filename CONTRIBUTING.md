# Contributing to Scopehatch

Read [README.md](README.md), [AGENTS.md](AGENTS.md), [actual implementation](docs/10-current-implementation.md), [workflow](docs/03-workflow-and-contracts.md), [Sprint 01](contracts/sprint-01-interface.md) and [Sprint 02](contracts/sprint-02-interface.md) contracts. The [Sprint 02 ownership map](docs/12-sprint-02-workstreams.md) and [release gates](docs/13-sprint-02-release-gates.md) govern parallel PRs. Contract/planning text does not itself prove working code.

## Branch, test, review

1. Fetch the latest `main`, inspect open PRs and CI for the exact base SHA. Create **your own dedicated feature/docs branch**, never modify `main` directly or reuse another worker's branch.
2. Keep edits inside the **exclusively assigned paths**. Shared contract, root lockfile, CI and integration changes belong to the integrator; document a **PROPOSED CONTRACT / INTEGRATION CHANGE** when a boundary needs another owner.
3. Add tests for the security and business invariants affected: tenant A/B, signed membership/role denial, stale revisions, independent review, deterministic money, evidence, idempotency/replay and concurrency/failure cases. Use synthetic data only.
4. Open one reviewable PR to `main` without merging it. Include base/head SHA, changed paths, old/new contract mapping, exact commands/results, failures/skips, remaining gaps and coordination needs. Unit mocks, fixture browser checks and live provider validation are **different evidence levels**.

From repository root, **Node.js 22+**:

```sh
npm ci --no-audit --no-fund
npm run build
npm run typecheck
npm run test:unit
npm run test:eval
npm run demo
```

`npm test` is an alias for `test:unit`. For fixture Chromium E2E:

```sh
npx playwright install chromium
npm run test:browser
```

For **real disposable PostgreSQL** testing, configure protected `TEST_PG_ADMIN_URL` and `TEST_PG_APP_URL`, then run `npm run test:db`. Missing DB URLs cause skipped tests, not a pass. The [integration workflow](.github/workflows/integration.yml) documents additional real-PostgreSQL Fastify/SDK, signed *synthetic* OIDC PKCE browser and Compose checks. To view the explicitly labeled local fixture (not a real authenticated installation), run `npm run dev --workspace @scopehatch/web` and open http://localhost:4173.

## Security and operations

Keep prices and reviews authoritative on the server; do not grant roles from untrusted request fields, let LLMs approve, blindly retry POST, or silently treat missing inference tokens as measured zero. Do not commit proprietary client/SVEIN content, credentials, provider keys, database admin URLs, JWTs, dumps, personal data or raw prompts to fixtures, logs and PRs. Seed Studio A/B users are test identities only. Never execute destructive SQL or restore against production; see [operations](docs/operations/README.md) and [recovery](docs/operations/backup-and-restore.md). Disclose vulnerabilities **privately** via a GitHub security advisory ([SECURITY.md](SECURITY.md)).

This is an [Apache-2.0](LICENSE) project. Preserve architectural reasons and test limits, not promotional implementation claims. An unmerged worker PR is not a shipped feature.
