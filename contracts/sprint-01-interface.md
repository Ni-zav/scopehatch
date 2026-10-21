# Sprint 01 shared interface (frozen for parallel PRs)

**Status: DESIGN CONTRACT, not an implemented API.** This is the integration target for independently developed packages. Refer to `src/domain.mjs` for existing runtime constraints, and `docs/03-workflow-and-contracts.md` for business behavior. **All external JSON fields below are camelCase.**

## Identity and authorization

All protected routes require a bearer access token with correctly verified asymmetric signature, issuer, audience and expiry. The server resolves a principal with `{ id: string, tenantId: string, roles: ('owner'|'operator'|'reviewer')[] }` **from verified identity and trusted membership records**, not from request body, unverified JWT claims or user-supplied tenant header. `tenantId` in API responses is informational, never client authority. Choose tenancy within verified membership context if multi-workspace identities exist. For a local demo, use test-issued signed JWTs and distinguish this from production identity setup; never rely on arbitrary development role headers in production.

## Domain objects

Catalog `{tenantId,currency,version,services:[{id,label,unitPriceMinor}]}`: ISO 4217 currency, version >=1, price and quantities safe integers in smallest units. Scope `{tenantId,projectId,revision,authorId,brief,deliverables:[{serviceId,quantity,evidence,source}],unknowns:string[]}`: quantity is positive safe integer or null, `source` is `brief|manual`. Estimate `{tenantId,projectId,scopeRevision,catalogVersion,currency,lines:[{serviceId,quantity,unitPriceMinor,subtotalMinor,evidence,source}],blockers:[{code,detail}],state:'blocked'|'ready',totalMinor:null|number}`. Review `{tenantId,projectId,scopeRevision,catalogVersion,state:'pending'|'approved',submittedBy,approvedBy:null|string}`.

Catalog, intake and scope revisions are immutable after persisted; new edits create a new revision and invalidate earlier review/export eligibility. Price creation and approval are never model operations.

## HTTP v1 contract

All `POST` writes require `Idempotency-Key` header; replay with same key+request body returns the stored result without performing the action again; key reused with different body returns 409. Structured JSON error body: `{error:{code,message,requestId}}`. For another tenant's object return 404 (not identifying whether it exists); for authenticated member with insufficient role return 403; unauthenticated 401. Validation 422, stale revision 409, unavailable provider 503, rate limited 429.

| Method | Path | Request body | Success |
|---|---|---|---|
| GET | `/healthz` | – | `{status:'ok'}` (liveness only) |
| GET | `/v1/catalogs` | – | `{items: Catalog[]}` |
| POST | `/v1/projects` | `{title:string,brief:string}` | 201 `{project:{id,title,brief,status:'draft'}}` |
| GET | `/v1/projects/:id` | – | 200 `{project,latestScope?,latestEstimate?,review?}` |
| POST | `/v1/projects/:id/scopes` | `{deliverables,unknowns}` | 201 `{scope: Scope}` |
| POST | `/v1/projects/:id/estimates` | `{scopeRevision:number,catalogVersion:number}` | 201 `{estimate: Estimate}` |
| POST | `/v1/projects/:id/reviews` | `{scopeRevision:number,catalogVersion:number}` | 201 `{review: Review}` |
| POST | `/v1/projects/:id/approve` | `{scopeRevision:number,catalogVersion:number}` | 200 `{review: Review}` |
| GET | `/v1/projects/:id/exports/:revision` | – | 200 `{projectId,revision,currency,totalMinor,markdown}` |
| GET | `/v1/projects/:id/audit` | query `cursor?,limit?` | `{items:AuditEvent[],nextCursor:string|null}` |
| POST | `/v1/projects/:id/suggestions` | `{scopeRevision?:number}` | 200 `{suggestion,provenance,model,usage}` or documented unavailable error; **draft suggestion, not scope mutation** |

The public API must ultimately be backed by durable DB state. A skeleton server with injected fake ports can be merged as **adapter-only**, not marked production ready. The web client can use typed mocks while the backend is unavailable; switch to real API in integration.

## Ports for independent implementation

`packages/persistence` should expose repository/transaction primitives for tenant-scoped catalog, project/intake, scope and estimate revisions, review, idempotency and audit. No repository method may accept an unchecked tenant or principal from HTTP client data. Document expected caller context. `apps/api` may implement injected `ApplicationService` port around the pure domain kernel; the integrator adapts persistence to these methods.

`packages/extraction` exposes `extractBrief(input:{brief:string,serviceCatalog:{id:string,label:string}[],requestId:string}, context:{tenantId:string,signal?:AbortSignal}): Promise<ExtractionResult>`; result contains `suggestedDeliverables:[{serviceId:string,quantity:number|null,evidence:{start:number,end:number,quote:string}|null}]`, `unknowns:string[]`, `provider:string`, `model:string`, `usage:{inputTokens?:number,outputTokens?:number,status:'reported'|'unknown'}`. Validate evidence offsets against exact UTF-16 JS string spans, reject fabricated spans, malformed outputs, unlisted serviceId; preserve null quantities. Providers cannot approve or price. Caller handles suggestion-to-scope conversion with manual review.

`packages/governance` exports pure provider eligibility/routing policy and transactional `reserve/settle/reconcile` operations via a storage port. Reserve under a tenant and idempotency key before billable calls; settlement never turns unknown usage into free. If database persistence is absent, tests run against an explicit fake store; do not claim multi-instance safety.

`tests/evaluations` reads representative synthetic briefs; outputs machine-readable evaluation results for extraction coverage, evidence validity, false price/approval claims and provider errors, with model/provider/seed and run parameters. No claimed measured benchmark without execution.

## Shared negative requirements

Never send external email; never silently update catalogs from prompts; never let AI override `unitPriceMinor`, `review.state`, `approvedBy` or `actor.roles`; do not leak client text or keys in telemetry; always verify tenancies and revision bindings; refuse ambiguous or stale approvals. Document anything a new integration PR must adapt rather than edit another workstream's files.

This contract may evolve only in a **single dedicated integration PR** once all stakeholders review the change.
