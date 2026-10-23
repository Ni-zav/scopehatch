# @scopehatch/sdk (Sprint 01 + Sprint 02 API adapter)

Typed, framework-agnostic TypeScript client for the **proposed** Scopehatch HTTP v1 contract. It makes the same HTTP requests as the operator workbench; it does **not** implement a backend, authentication server, local RBAC, approval engine, or autonomous agent.

## Run locally

Use Node.js >=18 and TypeScript >=5.6. From `packages/sdk`:

```sh
npm install
npm run typecheck
npm test
npm run example
```

The example uses deterministic in-process mock responses and a **fake test token**. No real server or reviewer is contacted. For a minimal environment with `tsc` installed globally, these scripts also run without installing dependencies. The mock does not prove server enforcement.

## Public API

```ts
import { ScopehatchClient, ScopehatchHttpError } from '@scopehatch/sdk';

const sdk = new ScopehatchClient({
  baseUrl: 'https://your-scopehatch-api.example',
  credentials: { getAccessToken: async () => getFreshOidcToken() },
  timeoutMs: 15_000,
  // fetch: customFetch, // optional injected standards-compliant transport
});

const project = await sdk.createProject(
  { title: 'Exterior visuals', brief: 'Two exterior views' },
  { idempotencyKey: 'intake-workflow-42' },
);
const scope = await sdk.createScope(project.id, {
  deliverables: [{ serviceId: 'exterior', quantity: 2,
    evidence: 'Two exterior views', source: 'brief',
    clientDescription: 'Two sunset exterior views' }],
  unknowns: [],
  proposal: {
    overview: 'Exterior render deliverables', assumptions: ['Client supplies model'],
    exclusions: ['Animation'], commercialTerms: ['Timeline confirmed in writing'],
  },
}, { idempotencyKey: 'scope-workflow-42' });

// The catalog is a complete owner-controlled replacement, not an incremental rate edit.
const newCatalog = await sdk.createCatalog({
  baseVersion: 0, currency: 'IDR',
  services: [{ id: 'exterior', label: 'Exterior render', unitPriceMinor: 2500000 }],
}, { idempotencyKey: 'catalog-onboarding-42' });
const projectsPage = await sdk.listProjects({ limit: 20 });
const nextPage = projectsPage.nextCursor
  ? await sdk.listProjects({ limit: 20, cursor: projectsPage.nextCursor }) : null;
const catalogs = await sdk.listCatalogs();
const binding = { scopeRevision: scope.revision, catalogVersion: catalogs[0]!.version };
const estimate = await sdk.createEstimate(project.id, binding,
  { idempotencyKey: 'estimate-workflow-42' });
if (estimate.state !== 'ready') throw new Error('Resolve blockers before review');
await sdk.submitReview(project.id, binding,
  { idempotencyKey: 'review-workflow-42' });

// A SEPARATE verified reviewer may call approveReview using THEIR token.
// Nothing in the SDK grants reviewer status or bypasses separation of duties.
const proposal = await sdk.exportApprovedProposal(project.id, scope.revision);
console.log(proposal.markdown);

const firstPage = await sdk.listAudit(project.id, { limit: 20 });
const secondPage = firstPage.nextCursor
  ? await sdk.listAudit(project.id, { cursor: firstPage.nextCursor, limit: 20 }) : null;
```

Also exposed: `getProject`, `approveReview`, `suggestScope`, `staticBearerToken` (for explicitly managed tokens), typed errors (`ScopehatchHttpError`, `ScopehatchTimeoutError`, `ScopehatchAbortError`, `ScopehatchNetworkError`, `ScopehatchProtocolError`, `ScopehatchConfigurationError`, `ScopehatchAuthenticationError`), request-level `AbortSignal` and `timeoutMs`.

The SDK intentionally does not accept an authoritative `tenantId`, `actorId`, `role`, `approvedBy`, or `version` on mutation inputs; only catalog services accept owner-authored `unitPriceMinor` on `createCatalog`. It serializes allowlisted properties, so runtime extra properties supplied by JavaScript callers are discarded. Server-side validation and authorization remain mandatory.

## Transport security

The SDK requires HTTPS for remote API connections because requests include an
OIDC bearer token and optional workspace selector. Plain HTTP is accepted only
for literal loopback `localhost`, `127.0.0.1`, or `[::1]` development endpoints.
HTTP redirects are rejected instead of being followed. If deploying behind a
reverse proxy, configure its public HTTPS address as `baseUrl`; do not point
the SDK at an unencrypted private-network hostname.

## Retries and idempotency

All `POST` requests require an explicit `idempotencyKey`; the SDK will not manufacture one. By default, GET requests retry up to 2 additional times on `429`, `502`, `503`, `504` and transport errors; POST requests are **never retried** by default. If a deployed server correctly implements the frozen idempotency contract and the caller accepts the risk, a POST can opt in with `{ idempotencyKey, retry: true }`. Every retry sends the same body and idempotency key. Never reuse one key for a different body. No retry occurs on `401`, `403`, `404`, `409` or `422`. Retry delays and `Retry-After` are bounded; no unbounded retry loops or hidden approval calls.

`timeoutMs` applies to the overall request (credential lookup, retries, body read). Caller cancellation propagates to the fetch signal. An injected fetch should obey AbortSignal to actually stop underlying I/O; the SDK returns a timeout even if that transport does not cooperate. HTTP exception messages do not echo raw server bodies, tokens or URLs.

## Integration contract and limitations

- Target: `contracts/sprint-01-interface.md` plus the frozen additive `contracts/sprint-02-interface.md` on main. Fields not frozen there (such as audit event structure, suggestion payload and error-code vocabulary) remain `Record<string, unknown>` / `unknown` rather than guessed schemas.
- The domain kernel currently uses **string evidence citations**, so `Deliverable.evidence` is a string. Structured offset evidence from extraction must be normalized by a future integration adapter **or changed only in a coordinated contract PR**.
- TypeScript types and simple envelope checks do **not** replace runtime server validation. Dynamic JSON fields require downstream checks before sensitive use.
- Tenant access, OIDC verification, revision freshness, catalog prices, reviewer independence, idempotency persistence and export authorization can only be proven with a live, wired backend and integration tests. The standalone SDK cannot enforce them.
- The SDK includes no root workspace configuration or CI wiring by design; the integrator must add it after reviewing other Sprint 01 PRs. No real network requests were run by the example/tests.
- No support yet for token refresh challenge negotiation, generated OpenAPI clients, Node <18, alternative HTTP media types, streaming, package publication or MCP adapters.

This directory is solely owned by the SDK workstream. Do not modify sibling packages, root manifests or the frozen shared contract in this PR.


## Sprint 02 compatibility and authority

- `createCatalog({ baseVersion, currency, services }, { idempotencyKey })` creates **one complete immutable version**; `baseVersion: 0` is only valid for the first catalog. Existing catalog services are not patched. Only the server can verify owner membership, serialize concurrent version changes, reject stale/replayed writes, or select the resulting version.
- `listProjects({ limit?, cursor?, signal?, timeoutMs? })` returns `{items,nextCursor}` ordered by the server; `limit` is 1–100 and the opaque cursor belongs to the verified workspace. No client tenant filtering, role selector or local project-status derivation is provided. Do not persist/reuse a cursor across workspaces.
- `createScope` can send optional `clientDescription` per line and a `proposal` with `overview`, `assumptions`, `exclusions`, `commercialTerms`. Sending revised text creates a **new scope revision**, requiring re-estimation, independent review and fresh approval on the server. Legacy calls without these keys produce their original bodies.
- New scope reads and approved export responses contain normalized proposal metadata on Sprint 02 servers. The TypeScript fields stay optional so SDK clients can also consume older Sprint 01 deployments; treat absent proposal as `{overview:'',assumptions:[],exclusions:[],commercialTerms:[]}` in presentation logic.
- New method responses receive focused shape checks for project pages and catalog creation. This is not a general JSON-schema validator; the authenticated API is authoritative for permissions, money, tenant scope, revision freshness, cursor binding and replay.
- A Sprint 01 server may return 404 for the new endpoints or 422 for new scope metadata; upgrade the API and persistence together. Typed `ScopehatchHttpError` exposes the actual status, safe error code and request ID. Malformed success bodies raise `ScopehatchProtocolError`, transport/timeouts/cancellation retain their existing typed failures.
- `examples/mock-workflow.mjs` and SDK tests use only deterministic local mock HTTP. They do not prove live OIDC, PostgreSQL isolation or server authorization. No privileged onboarding/tenant-creation endpoint is included.
