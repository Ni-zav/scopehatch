# Core workflow and domain contracts

Workpack ID: `brief-to-proposal` (see `workpacks/`).

## Versioned records
Tenant → Project → Immutable Intake → ScopeRevision → EstimateRevision → Review → Export. CatalogVersion is tenant-owned and immutable once referenced. Every foreign key is checked against tenant ownership in queries and security tests.

ScopeRevision includes authorId, projectId, revision number, brief reference, deliverables, unknowns and evidence. A deliverable has catalog serviceId, integer quantity or explicit null, and evidence (brief citation or manual override). A rate card has ISO currency, integer smallest-unit prices, and version.

## State machine
DRAFT → BLOCKED (pricing blocker) or READY → PENDING_REVIEW → APPROVED → EXPORTED. Any change to scope or catalog version invalidates the prior quote/approval relationship; do not carry an approval forward by mutating the record.

Blockers: unknown quantity, unknown requirement, unpriced service, missing cited evidence, no deliverable, unsupported currency or arithmetic overflow.

Approval is bound to: tenant, project, scope revision, catalog version, estimate identity and approving principal. A different authorized user reviews the work. In production the principal comes from verified auth middleware, never a client-submitted actor object.

## API plan (not yet implemented)
`POST /v1/projects`, `POST /v1/projects/:id/scopes`, `POST /v1/projects/:id/estimates`, `POST /v1/projects/:id/reviews`, `POST /v1/projects/:id/approve`, `GET /v1/projects/:id/exports/:revision`. Require idempotency keys on billable or side-effecting POST requests, consistent authorization responses and cursor pagination.

## AI proposal boundary
LLM responses are untrusted suggestions. Parse strictly, validate schema, attach evidence spans, and never allow prompts to generate prices, new catalog entries, authorization flags or self-approval. A fabricated quote must fail in the rule engine.

## Events
Record actor, tenant, project, timestamp, object revision, action, request ID, and normalized outcome. Default logs must not expose prompt text, credentials, PII or raw client assets.