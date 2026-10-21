# Scopehatch operator workbench — Sprint 01 (#4)

Vue 3 / TypeScript / Vite implementation of the **manual** brief → evidence-backed scope → catalog estimate → independent review → exact approved proposal export journey.

> This package is a separately runnable frontend, **not** a production deployment. Its demo data, studio prices and identities are entirely synthetic and reset on refresh. The API and PostgreSQL workstreams are independent and must be integrated and security-tested before live use.

## Run

Requires Node.js 22+. Run commands **from `apps/web`**, not the repository root.

| Command | Effect |
| --- | --- |
| `npm install` | Install this package's dependencies |
| `npm run dev` | Development server at http://localhost:4173 in **clearly marked fixture mode** |
| `npm run dev:api` | Development server in production/API mode (see identity boundary below) |
| `npm run typecheck` | Vue + TypeScript checking |
| `npm run test` | Unit tests: HTTP transport and deterministic two-person fixture |
| `npm run build:demo` | Typecheck and produce a **fixture-only** static bundle for screenshots/demo |
| `npm run build` | Typecheck and produce the default **API-only** bundle (no fixture mode) |
| `npx playwright install chromium` | Install browser for Playwright (once) |
| `npm run test:e2e` | Desktop and mobile Chromium flows, auto-launching the demo server |

No files or configuration outside `apps/web/` are modified by this module. The root package manager, CI and production auth integration are owned by the integrator.

## Human flow

1. Paste a source brief and save a titled project; that text remains unmodified.
2. Add service lines from a tenant-owned catalog; choose quantities, quoted evidence or manual notes, and unresolved requirements. The source panel highlights exact matching evidence.
3. Save a new scope revision; the client requests a deterministic estimate for that revision and catalog version. Blocked totals display **Not priced** rather than speculative money.
4. Submit only a current, ready estimate for review. A different authorized principal approves **exactly** that revision and catalog version.
5. Only a current approved revision can fetch a proposal export. The response is checked for project/revision match, shown read-only, and downloadable as Markdown or JSON. Export **does not send email**.
6. Inspect the project's paginated audit timeline. An edited scope starts a new revision, supersedes previous review eligibility, and locks preview/export again.

The fixture starts with an intentionally blocked fictional archviz project. Correct the exterior quantity and the unresolved CAD-file question to make the estimate ready. Change the **fixture persona** from Morgan/operator to Alex/reviewer to test approval. This selector simulates server rules **only inside the fixture**; it is not authentication and no such selector is transmitted to a real API.

## HTTP contract

`src/types.ts` models the Sprint 01 JSON objects. `src/api.ts` maps to the frozen endpoints:

- `GET /v1/catalogs`, `POST /v1/projects`, `GET /v1/projects/:id`
- `POST /v1/projects/:id/scopes`, `POST /v1/projects/:id/estimates`
- `POST /v1/projects/:id/reviews`, `POST /v1/projects/:id/approve`
- `GET /v1/projects/:id/exports/:revision`, `GET /v1/projects/:id/audit?cursor=&limit=`

All POST requests use a fresh `Idempotency-Key` and JSON bodies, errors are decoded as `{error:{code,message,requestId}}`, and project identifiers are URL-encoded. The client never supplies tenant/actor/role fields to assert authority. The server must enforce access, separate-person approval, immutable revisions, idempotency, and audit; disabled UI controls are merely affordances.

The shared contract has **no list-projects route**, so the UI offers a project-ID opener and shows the currently created/open project rather than inventing a listing endpoint. Audit-event fields are not fully frozen, so the reader tolerates missing optional metadata without fabricating an actor or timestamp. The interface does not call the optional inference suggestion route; manually entered scope is fully useful.

### Production identity and environment

By default `npm run build` compiles **API mode**. It has no hardcoded token or permissive fallback. `createHttpApi({ baseUrl, getAccessToken })` needs a real OIDC **access-token provider**; `src/App.vue` currently passes `async () => null` intentionally, so protected requests fail locally with an `AUTH_REQUIRED` message until the integrator provides a verified login/session module. Do **not** replace this with a static token, arbitrary role header, JWT decode-only validation, or a demo persona.

After integrating OIDC, supply a trustworthy `getAccessToken` implementation to the HTTP factory, and set `VITE_SCOPEHATCH_API_BASE_URL` to the reverse-proxy base path (e.g. `/api`). The identity provider obtains/verifies sessions and the backend independently validates signature, issuer, audience, expiry and membership. Use HTTPS, appropriate CSP/CORS, CSRF/session design and server-side auth checks. Keep access tokens out of build-time `VITE_*` variables and localStorage.

Only `vite --mode demo` / `vite build --mode demo` injects `VITE_SCOPEHATCH_DEMO=true` via `.env.demo`. **Do not deploy that static bundle as the live product.** The explicit banner and synthetic persona prevent confusing fixture approvals with real ones. Previewed JSON and Markdown include only the backend's approved export response in API mode.

### Integration assumptions / required gates

1. API implements the frozen request/response wrappers in `contracts/sprint-01-interface.md`, including `GET /v1/projects/:id` with optional latest scope, estimate and review, and cursor audit pagination.
2. API publishes a trusted token endpoint/OIDC integration path; the frontend auth provider is separately wired by the integrator. **No live login is implemented here.**
3. API returns the most recent review (including a previous revision where applicable), allowing superseded state; if it only returns the active review, the UI safely treats an absent review as unapproved and audit retains history.
4. Catalog discovery responds with at least one versioned catalog for a workspace. For Sprint 01 the UI edits against the first returned catalog; multi-catalog selection is future work.
5. The API returns only an approved, current revision from `GET /exports/:revision`; `totalMinor` is the ISO currency's smallest units. Preview/export eligibility must be rechecked server-side every time.
6. Side-effecting requests are not automatically retried. The HTTP client generates idempotency keys for each user action. Automatic retry/replay with a reused key, if needed, belongs in a future scoped integration update.
7. No production metrics, durable fixture data, AI inference, or file/PDF export are claimed. Exports are Markdown/JSON proposal **drafts**, not signed quotations.

## Tests and accessibility

`src/demo.test.ts` covers blocked estimates, two-person review, revision supersession, role denials, stale requests, evidence and arithmetic guards, audit pagination and fixture isolation. `src/api.test.ts` covers auth headers, no-token fail-closed behavior, structured API errors and encoded paths. `e2e/workbench.spec.ts` walks through the full fixture journey, a fresh intake, reviewer restrictions, and keyboard skip-link behavior on desktop and mobile Chromium.

Forms use real labels, semantic headings, an accessible status/error region, keyboard-focus styles, responsive stacking, and reduced-motion preferences. Manual citation highlighting is rendered as text, never injected HTML.

### Screenshot workflow

After dependencies and Chromium are installed, start `npm run dev` and take a local browser screenshot, or let Playwright capture failure screenshots in `test-results/`. Screenshots and build artifacts are ignored from Git; they are not evidence unless the browser actually ran.

## Known limitations

- No actual OIDC session integration or production authorization verification inside the frontend (correctly delegated to server and integration workstream).
- Fixture storage is in-memory, deterministic and isolated per reload. Its personas are not real JWTs.
- There is no project-list endpoint, no catalog management endpoint, no review-rejection endpoint and no historical export endpoint in Sprint 01. UI does not invent them.
- Source citations are free-text quotes/manual notes; the backend is responsible for authoritative validation.
- No browser/TypeScript test outcome should be claimed unless the corresponding command has been executed.

Related contract: `contracts/sprint-01-interface.md`; issue: https://github.com/Ni-zav/scopehatch/issues/4.
