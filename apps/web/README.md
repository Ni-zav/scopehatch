# Scopehatch operator workbench — Sprint 02

Vue 3 / TypeScript / Vite operator application for *brief → scope and client proposal content → deterministic estimate → independent human review → exact approved export*.

**Production and fixture modes are deliberately separate.** `npm run dev` starts a conspicuously marked synthetic demo; `npm run dev:api` uses OIDC access tokens and protected API routes. Synthetic identities, catalog prices, documents and approvals are not production authentication, persistence or integration proof.

## Local commands

From the repository root, run `npm ci` first (workspace lockfile is integrator-owned). Then, from `apps/web`:

| Command | Purpose |
| --- | --- |
| `npm run dev` | Local-only synthetic demo on Vite |
| `npm run dev:api` | Real protected HTTP adapter with configured OIDC provider |
| `npm run typecheck` | `vue-tsc --noEmit` |
| `npm run test` | Vitest transport and deterministic fixture tests |
| `npm run test:e2e` | Playwright desktop and mobile Chromium (install Chromium once) |
| `npm run build` | Typecheck and build production/API-only bundle |
| `npm run build:demo` | Typecheck and build marked synthetic fixture bundle |

These commands do **not** create tenants, seed production data, execute a real model, deploy containers, or imply operational approval. Production login requires the OIDC settings in `src/oidc.ts` and a separately provisioned trusted principal with active tenant membership.

## New operator features

- **Projects:** `GET /v1/projects?limit=&cursor=` displays current **server-derived** statuses (`draft/blocked/ready/pending/approved`), new-to-old pages and reopen-by-title. No UI-supplied tenant filter. The optional workspace selector chooses only a verified server membership; the server conceals other tenants.
- **Catalogs:** any active tenant member can read version history. Publication uses `POST /v1/catalogs` with a *complete* service replacement, required `baseVersion`, valid ISO currency and integer minor-unit amounts. Each save publishes a new immutable version; `409 STALE_CATALOG_VERSION` leaves edits unsaved and `403` hides publishing controls for this session. Only the API/database can establish owner privileges.
- **Proposal content:** each immutable scope revision can store `proposal.overview`, `assumptions`, `exclusions`, `commercialTerms` and `deliverables[].clientDescription`. All are human-authored text, rendered by Vue interpolation (never `v-html`). Changing even one sentence is a **new revision** with new estimate/review eligibility. This text cannot override catalog-derived totals.
- **Human checks:** original unmodified client brief, source citations, unknowns, blockers, exact scope/catalog/estimate review binding, read-only approved Markdown/JSON and project audit remain visible. Export never sends email or publishes a signed quote.
- **Dirty state:** navigation and browser leave warn about unsaved scope/catalog edits. Network and server errors use clear error regions, request IDs where present, and no optimistic approval.

### Role discovery limitation

The frozen Sprint 02 HTTP contract has **no trusted current-membership/role discovery endpoint**. The fixture hides owner-only publishing until its synthetic owner persona is selected. In API mode, authenticated members initially see the publisher editor with an explicit owner-verification notice; the server rejects nonowners and the form hides after a `403`. Client-only role hints would not be authorization. Fully *preemptive* hiding requires a future trusted server-side identity/membership read contract; **do not invent an unsecured client claim** to simulate it.

### Unmerged cross-module dependencies

This frontend branch uses exactly the frozen Sprint 02 request and response shape. On the Sprint 01 API baseline, `GET /v1/projects`, `POST /v1/catalogs` and new scope metadata are still unavailable; matching `apps/api/**` and PostgreSQL worker PRs must be integrated and verified against protected OIDC before claiming production first-run functionality. Host-only studio/initial-owner provisioning is a separate administrative task and never a web route.

The fixture remains local to `src/demo.ts`, in memory, and resets on reload. It simulates pagination, owner catalog CAS, immutable text revisions, independent review and stale export for self-contained tests; it is not a tenant-isolation security test.

## Tests and boundaries

Unit suites `src/api.test.ts` and `src/demo.test.ts` exercise authorization headers, idempotency, pagination cursors, metadata forwarding, forbidden owner actions, stale catalog publishing, deterministic blockers and superseded review/export. `e2e/workbench.spec.ts` exercises source evidence, project revisit, catalog editing, human review, proposal metadata, keyboard skip link and mobile viewport configurations. Actual results are those of the PR-head CI run; no unexecuted tests may be claimed green.

No cross-workspace data must be retained by the frontend after sign-out. Owner roles, JWT verification, idempotency replay/concurrency, RLS and exact export authorization remain server/database responsibilities. Only `apps/web/**` is modified by this worker.
