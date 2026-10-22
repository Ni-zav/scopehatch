# Scopehatch

**From messy requests to reviewed, approved work.**

Scopehatch is an Apache-2.0 self-hostable workbench for service studios turning ambiguous briefs into evidenced scopes, deterministic catalog-priced estimates, independent human review, and exportable **proposal drafts**. The first use case targets archviz, design and software-service agencies. It is not a customer-ready hosted service, invoicing product, or autonomous sales agent.

> **Evidence snapshot (22 October 2026):** `main` at `0b8e259` contains integrated Sprint 01 Fastify, PostgreSQL, Vue, SDK, governed extraction and Compose code. [Core CI](https://github.com/Ni-zav/scopehatch/actions/runs/39702122223) and [integration CI](https://github.com/Ni-zav/scopehatch/actions/runs/39702122224) both passed on that exact commit. The frozen Sprint 02 contract specifies **planned** additions, not already implemented routes. See [the evidence ledger](docs/10-current-implementation.md).

## Developer quickstart

Requires Node.js **22+** and npm, from repository root:

```sh
npm ci --no-audit --no-fund
npm run build
npm run typecheck
npm run test:unit
npm run test:eval
npm run demo
```

`npm run demo` prints a synthetic **in-process** proposal, not a live authenticated service. For the separately labeled **fixture-only** Vue workbench:

```sh
npm run dev --workspace @scopehatch/web
```

Visit http://localhost:4173 (see `apps/web/vite.config.ts`). The fixture's identities, prices and approvals are not real. For browser fixture tests install Chromium (`npx playwright install chromium`), then run `npm run test:browser`. These scripts are defined by root and workspace `package.json`; `npm test` aliases `npm run test:unit`.

## Built versus unverified

| Integrated and tested in Sprint 01 | Limits |
| --- | --- |
| [Pure domain](src/domain.mjs): immutable revisions, integer-minor money, blockers, separate reviewer and Markdown draft | A proposal draft is not a signed/binding quotation |
| [Fastify](apps/api/src/server.ts), [PostgreSQL](packages/persistence/index.mjs), [migrations](db/migrations/005_inference_governance.sql): signed JWT, trusted membership, tenant-scoped state, replay/audit | No externally verified production IdP/onboarding or independent security certification |
| [Vue](apps/web/src/App.vue), [browser PKCE](apps/web/src/oidc.ts), [SDK](packages/sdk/src/client.ts): protected manual API workflow and synthetic fixture demo | Owner catalog creation, project index and rich proposal metadata are Sprint 02 plans |
| [Extraction](packages/extraction/index.mjs) and [governance](packages/governance/src/index.mjs): tenant-gated suggestions, budget reservations, evaluation fixtures | Fixture is **not** a real model benchmark; model output never sets fees/approvals |
| [Compose](deploy/compose.yaml): images, migration, runtime DB role and health smoke tests | No independently rehearsed backup restore or customer-ready deployment |

The passing [Sprint 01 integration jobs](https://github.com/Ni-zav/scopehatch/actions/runs/39702122224) covered unit/fixture evaluations, restricted disposable PostgreSQL, synthetic signed OIDC Authorization Code + PKCE in Chromium with two actors, and Compose build/boot/health. They **did not** verify an external commercial IdP, live-model quality, restore or real customer deployment.

## Self-hosting

Follow [single-host operations](docs/operations/README.md), [integration assumptions](docs/operations/integration.md), and [backup/restore](docs/operations/backup-and-restore.md). A real install requires securely generated DB secrets, trusted OIDC issuer/JWKS and public PKCE client, **administratively provisioned active tenant memberships**, and trusted HTTPS before public access. The checked-in Studio A/B seeds are synthetic test data, never real owner onboarding. `/healthz` is liveness, not business-readiness. PostgreSQL data is authoritative; Redis and CPU-only Ollama are optional, GPU/Kubernetes unnecessary. No deployment has been externally certified.

## The workflow and future contract

An operator retains a brief, attaches grounded service lines, identifies unknowns and requests a deterministic estimate; a **different verified principal** reviews the exact current scope/catalog binding. Only a current approved revision is exportable; there is no automatic client send. AI suggestions are untrusted and cannot change catalog prices or approve work.

Existing Sprint 01 endpoints are explained in [workflow/contracts](docs/03-workflow-and-contracts.md) and the [frozen interface](contracts/sprint-01-interface.md). **Sprint 02 planned**: owner-only catalog version creation, paginated tenant projects, immutable scope-bound descriptions/terms, host-only first-owner provisioning, SDK/Vue parity, measured recovery and optional real-model evaluation. See [frozen Sprint 02 interface](contracts/sprint-02-interface.md), [workstreams](docs/12-sprint-02-workstreams.md) and [release gates](docs/13-sprint-02-release-gates.md). Individual worker PRs are not merged functionality.

Further reading: [product](docs/01-product-and-usecase.md), [positioning](docs/02-market-and-positioning.md), [architecture](docs/04-architecture.md), [security](docs/05-security-and-costs.md), [implementation plan](docs/06-implementation-plan.md), [actual implementation](docs/10-current-implementation.md), [contributing](CONTRIBUTING.md), [agents](AGENTS.md), [security reporting](SECURITY.md), [archived inference research](docs/archive/inference-lab/README.md). Historical research and schedules are not delivery claims. [LICENSE](LICENSE) supplies Apache-2.0; independently check brand/domain rights before launch.
