# Sprint 01: Parallel implementation ownership and integration protocol

This document coordinates independent ChatGPT coding sessions. It is the **sprint contract**, not evidence that the APIs, applications, or DB integrations exist yet. Read `AGENTS.md`, `docs/03-workflow-and-contracts.md`, and `contracts/sprint-01-interface.md` before implementing.

## Operating protocol

1. Fetch fresh `origin/main` and inspect open PRs; avoid duplicating an existing PR. Work on a unique `feat/s01-<area>` branch rooted in the latest main at the start of your session.
2. Each session owns only its listed paths. Do not edit `README.md`, `AGENTS.md`, `src/domain.mjs`, `package.json`, root lockfiles, `.github/workflows/`, or other sessions' paths; file ownership adjustments require the integrator to coordinate.
3. New packages must be independently testable from their own directory, with local package manifest if dependencies are needed. Root workspace and CI wiring are reserved for the integrator.
4. Contract-first development: use `contracts/sprint-01-interface.md` for names, field shapes, status and error semantics. Do not unilaterally edit shared contracts. When they cannot express a requirement, raise a **PROPOSED CONTRACT CHANGE** in the PR body and implement a local adapter with an explicit caveat.
5. Avoid live customer data, proprietary SVEIN content, real keys or false claims. Report exactly what was executed. All GitHub writes belong on branch; PRs to `main`. Do not merge your own PR.
6. Put integration blockers and incomplete cross-module wiring in the PR description; do not pretend a standalone module is an end-to-end product. CI may not run new package-specific tests until integration updates root workflows.
7. Scope each PR for review: purpose, implementation, tests with command/output, limitations, interface contract, dependency status, and integration instructions.

## Independent workstreams, folders, issues

| Worker | Owns exclusively | GitHub issue | Must NOT edit |
|---|---|---|---|
| DB | `packages/persistence/**`, `db/**` | #2 | API, core, shared contract |
| API | `apps/api/**` | #3 | DB migration, web, root manifest |
| WEB | `apps/web/**` | #4 | API, database, shared contract |
| AI | `packages/extraction/**` | #5 | API routes, core prices, provider governance |
| GOV | `packages/governance/**` | #6 | PostgreSQL migrations owned by DB, API |
| EVAL | `tests/evaluations/**`, `examples/evaluation/**` | #7 | Original `test/domain.test.mjs`, shared fixture manifest |
| OPS | `deploy/**`, `docs/operations/**`, `.env.example` if absent | #7 | Root CI, source code, app packages |
| AUDIT | Read-only audit; GitHub issue comments only on concrete defects | #2–#7 | Any code write or merge |
| INTEGRATOR | `package.json`, root lockfile, `.github/workflows/**`, integration shims and common docs | #2–#7 | Begin merge queue before contracts/tests ready |

An owner may add tests under their owned folder. Never let two sessions take the same branch or PR. If a file needs changes outside an owner's path, document the required integration edit rather than modifying it.

## Integration and merge order

First wave: DB, API-skeleton, WEB-mock, AI-adapter, GOV-policy, EVAL-harness, OPS-scaffolding can run simultaneously because they do not share owned files. The API skeleton and web must use mocks/ports rather than claim real DB integration. Governance implements reusable policy/ledger interfaces; DB-backed reconciliation happens in integration.

Second wave (integrator): verify and merge low-conflict PRs, first DB + API (with authentication + real persistence), then WEB, AI + GOV (tenant-safe serving), then evaluation + deployment. Rebase each remaining branch on new main before merge, check dependency status, and rerun all affected tests. Treat the complete security-critical flow as blocked until actual wired end-to-end tests pass.

## Definition of success

Demonstrate: a validated actor in tenant A can create a brief, set catalog-backed quantities, see blockers, obtain a deterministic estimate, submit review, receive approval by a **different** verified reviewer, and export an approved exact revision. Tenant B cannot read or act on tenant A. An AI suggestion never sets a price or approves itself. Model failures do not corrupt requests or budgets. Self-host quickstart succeeds without mandatory GPU.

## Non-goals for sprint

No production certification, billing SaaS, Kubernetes requirement, mail-sending agent, general CRM, public hosted deployment, multi-provider sweep, or speculative performance numbers.
