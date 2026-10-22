# Sprint 02 interface contract — brief to approved, usable proposal

**State:** proposed / frozen coordination target for Sprint 02 workers, **not an implementation claim**. Contract-owner branch `chore/s02-contract-foundation`, based on `main` at `e8bbfca7d8826d50808feb19419801259984df6e` (2026-10-22). Integrator must approve the decisions in `docs/12-sprint-02-workstreams.md` before merging runtime implementations.

## 0. Precedence, reality, and unchanged Sprint 01 rules

- Sprint 02 is **additive to** `contracts/sprint-01-interface.md`. Existing `/healthz`, `GET /v1/catalogs`, `POST /v1/projects`, `GET /v1/projects/:id`, scope/estimate/review/approval/export/audit/suggestion routes, current success envelopes, IDs, integer-minor money, and audit/idempotency requirements remain supported. Nothing below makes an unavailable feature operational.
- All public JSON keys are camelCase. Request objects reject unknown fields (`422 INVALID_INPUT`), except documented optional extensions. No public endpoint accepts an authoritative `tenantId`, `actorId`, `roles`, model-selected price or approval decision.
- For protected routes, validate signed asymmetric JWT (`RS256`/`ES256`), issuer, audience, `iat`/`exp` and `sub`. Use trusted active membership to resolve actor/roles/tenant. `X-Workspace-Id` selects **only** an existing verified membership; it cannot create one. Ambiguous memberships without a selector fail closed.
- Scope/intake/catalog/estimate data are immutable; edits create revisions. Approvals require an exact current tenant+project+intake+scope+catalog+estimate binding, a ready quote, and an independent authorized reviewer. No self-approval; model or agent requests never bypass human controls.
- All `POST` calls require `Idempotency-Key` (1–200 printable non-space ASCII bytes per current API; SDK currently constrains to 128, which remains valid). PostgreSQL currently keys by tenant+key and conflicts on changed actor/operation/payload: **clients must not reuse a key for another action**. Successful identical replay returns the same HTTP status/body and causes no duplicate effect, including after restart or concurrency.
- Error envelope remains `{"error":{"code":"STRING","message":"safe text","requestId":"string"}}`. No cross-tenant existence or raw DB/secret/provider details are disclosed. Standard `401` unauthenticated, `403` insufficient role, `404` foreign/nonexistent resource, `409` conflict/stale/replay mismatch, `422` invalid request/cursor, `429` capacity/budget, `502` invalid model output, `503` missing provider/dependency, `504` timeout; `500` unexpected failure. All errors must carry requestId.
- No general workflow engine, anonymous signup, auto-email, invoice billing, arbitrary plugins or mandatory Kubernetes/GPU. Deterministic prices alone bind commercial totals; freeform text cannot override them.

## 1. Shared wire types (TypeScript-like; normative JSON)

```ts
type Role = 'owner' | 'operator' | 'reviewer';
type ProjectStatus = 'draft' | 'blocked' | 'ready' | 'pending' | 'approved';
type Source = 'brief' | 'manual';
type Service = { id: string; label: string; unitPriceMinor: number };
type Catalog = {
  tenantId: string; currency: string; version: number; services: Service[];
};
type Project = {
  id: string; title: string; brief: string; status: ProjectStatus;
  tenantId?: string; // existing GET can include informational tenantId
};
type ProjectSummary = {
  id: string; title: string; status: ProjectStatus; createdAt: string; // RFC 3339 UTC
};
type ProjectPage = { items: ProjectSummary[]; nextCursor: string | null };
type ProposalMetadata = {
  overview: string;
  assumptions: string[];
  exclusions: string[];
  commercialTerms: string[]; // human-authored *text*, not calculated money
};
type Deliverable = {
  serviceId: string; quantity: number | null;
  evidence: string; source: Source;
  clientDescription?: string; // omitted in legacy writes; normalized to "" on read
};
type Scope = {
  tenantId: string; projectId: string; revision: number;
  authorId: string; brief: string; deliverables: Deliverable[];
  unknowns: string[]; proposal?: ProposalMetadata;
};
type Estimate = {
  tenantId: string; projectId: string; scopeRevision: number;
  catalogVersion: number; currency: string;
  lines: {serviceId: string; quantity: number | null;
    unitPriceMinor: number | null; subtotalMinor: number | null;
    evidence: string; source: Source}[];
  blockers: {code: string; detail: string}[];
  state: 'blocked' | 'ready'; totalMinor: number | null;
};
type Review = {
  tenantId: string; projectId: string; scopeRevision: number;
  catalogVersion: number; state: 'pending' | 'approved';
  submittedBy: string; approvedBy: string | null;
};
type ApprovedProposal = {
  projectId: string; revision: number; currency: string;
  totalMinor: number; markdown: string;
  proposal?: ProposalMetadata; // additive read-only normalized snapshot
};
type ApiError = {error: {code: string; message: string; requestId: string}};
```

`proposal` is optional for old request/response compatibility; **Sprint 02 successful scope reads and approved exports MUST return the normalized proposal object**, even when the legacy writer omitted it. Default: `{"overview":"","assumptions":[],"exclusions":[],"commercialTerms":[]}`; default each missing `clientDescription` to `""` on new reads. JSON arrays preserve author-controlled order. No generated boilerplate or inferred terms. A client accepting pre-S02 responses must treat absent metadata as the same default.

Validation limits for **new** metadata fields: `overview` 0–4,000 characters; `clientDescription` 0–2,000 per deliverable; `assumptions`, `exclusions`, `commercialTerms` each 0–50 strings, each entry 1–2,000 characters after trim; total serialized metadata <= 64 KiB. Empty strings valid only for overview/clientDescription, not array entries. Do not silently truncate. A minimum of one service is required for new catalog creation; `services` max 200; service IDs unique and nonblank; rate is a safe integer `0..9007199254740991`; ISO 4217 three-letter uppercase currency code (reject unsupported currency rather than guess fractional digits). Quantity remains positive safe integer or explicit `null`. All text is untrusted for rendering; escape HTML and avoid automatic remote loads. New metadata may not be supplied by model suggestions as authoritative text.

## 2. Catalog creation: owner-gated immutable full version

### POST /v1/catalogs (NEW; not in live API yet)

Authorization: active **owner** membership in selected workspace. Neither operator/reviewer nor a model has write access. New versions are **complete replacements** of the tenant's current service set; omitted services do not exist in the new version. No `PUT`, `PATCH` or delete endpoint in Sprint 02.

Request with `Idempotency-Key`:

```json
{
  "baseVersion": 0,
  "currency": "IDR",
  "services": [
    {"id":"exterior","label":"Exterior render","unitPriceMinor":2500000},
    {"id":"interior","label":"Interior view","unitPriceMinor":1500000}
  ]
}
```

`baseVersion` is REQUIRED nonnegative safe integer: `0` is the expected absence of any catalog; otherwise equals the tenant's current latest version. Server, not caller, chooses new `version = baseVersion + 1` inside a tenant-serialized transaction. It cannot be supplied in the body. Version numbers are monotonic per tenant and never reused, deleted or modified. For editing, client GETs latest catalog and sends full desired replacement with its version as `baseVersion`.

Success: `201 {"catalog":{"tenantId":"...","currency":"IDR","version":1,"services":[...]}}`. Existing `GET /v1/catalogs` remains `200 {"items":[Catalog, ...]}` ordered version descending (empty array for first-run tenant). Old version reads remain internally available for audit; public `GET /v1/catalogs` continues to expose the historical versions to active tenant members.

Failure cases: `403 FORBIDDEN` for nonowner; `409 STALE_CATALOG_VERSION` for wrong baseVersion (including concurrent owners, with **no new row**); `409 IDEMPOTENCY_CONFLICT` for changed replay; `422 INVALID_INPUT`/`DUPLICATE_SERVICE`/`MONEY_OVERFLOW`; `401` without valid identity. Scope or review changes are **never** auto-generated by catalog writes. Publishing **any new version** makes earlier estimates/reviews ineligible for new approval/export until recomputed/reviewed against latest version, even if individual rate values happen to be equal. Historical immutable approvals and audit remain preserved; they do not authorize current export.

Database requirement: reuse tenant-locked `catalog_versions` + `catalog_services` and completeness/immutability triggers; tighten DB write authorization to owner-only, not merely HTTP RBAC (current SQL and repository admit operators). Make the latest-version check, insert, children, audit and idempotency response one atomic unit. Test concurrent owner CAS, duplicate service ID, zero-priced service (permitted), cross-tenant/membership denial, operator attempting direct persistence insert, and stale existing approval/export.

## 3. Project index and derived status

### GET /v1/projects (NEW; not in live API yet)

Protected by any active owner/operator/reviewer membership. Tenant inferred exclusively from verified membership and optional authorized workspace selector. No `tenantId` query/filter. Query: optional `limit` as ASCII integer `1..100` (default `20`), optional opaque `cursor` (max 512 URL-safe characters). No arbitrary `sort`, `offset`, full-text, cross-tenant search or status filter in Sprint 02.

```http
GET /v1/projects?limit=2
Authorization: Bearer <access-token>
X-Workspace-Id: <verified-membership-workspace>
```

```json
{
  "items": [
    {"id":"project-b","title":"Villa 3D","status":"ready","createdAt":"2026-10-21T10:01:00.000Z"},
    {"id":"project-a","title":"Office design","status":"draft","createdAt":"2026-10-21T09:59:00.000Z"}
  ],
  "nextCursor":"opaque-tenant-bound-cursor"
}
```

`createdAt` originates at DB insert, not client clock. Order `created_at DESC, id DESC` (id tie breaker); keyset pagination, no duplicates across page boundaries for an unchanged dataset. Cursor encodes the last position and is validated and **tenant-bound**; other-tenant cursor, malformed/expired cursor or unsupported limit -> `422 INVALID_CURSOR`/`INVALID_INPUT`, never a data leak. Concurrent inserts may appear only when restarting from page one; no snapshot guarantee. `items:[]` and `nextCursor:null` for no projects. Do not include full client `brief` in list results.

Status is a **derived read model**, never an independently mutable project field. Compute from the **latest intake, latest scope, latest catalog and latest estimate** plus the review tied to that exact estimate; precedence:

1. `draft` if no current scope or no estimate matching latest intake+scope+catalog, including when an old approval is now superseded.
2. `blocked` if the matching estimate has pricing blockers/state blocked.
3. `ready` if current estimate is ready without a current review.
4. `pending` if current ready estimate has pending review.
5. `approved` if **that exact** current estimate has an approved review.

Do not return `exported` as persistent state: downloading is an audited event, not a new current approval state. Both list and `GET /v1/projects/:id` `project.status` must use the **same** status calculation. The latter keeps the existing `{project,latestScope?,latestEstimate?,review?}` envelope, including historically returned `review`; consumers must match its revisions before labeling approval current. `POST /v1/projects` stays `201 {"project":{"id":"...","title":"...","brief":"...","status":"draft"}}`, with optional additive read fields only.

DB requirement: index tenant+`created_at`+`id`; tenant-scoped keyset query under RLS; derive status without a per-project N+1 series; treat catalog supersession consistently. Test reviewer visibility, tenant A/B page isolation, forged selectors, two projects sharing timestamp, cursor traversal, deterministic statuses and catalog/scope stale fallback to draft.

## 4. Backward-compatible, scope-bound proposal content

### POST /v1/projects/:id/scopes (EXISTING; additive OPTIONAL fields)

Keep original required `deliverables`, `unknowns`, evidence/source/quantity semantics. Add optional `clientDescription` on each deliverable and optional `proposal`. The API must accept legacy payloads without either property, and must reject unknown nested properties. Body example:

```json
{
  "deliverables": [
    {
      "serviceId":"exterior","quantity":2,
      "evidence":"2 exterior views","source":"brief",
      "clientDescription":"Two dusk exterior views with one review round"
    }
  ],
  "unknowns":[],
  "proposal":{
    "overview":"Exterior visualization for the new building",
    "assumptions":["Client supplies a confirmed 3D model"],
    "exclusions":["No animation"],
    "commercialTerms":["Delivery milestones confirmed in writing before production"]
  }
}
```

Success remains `201 {"scope":Scope}`; the response includes normalized `proposal` and normalized `clientDescription`. Do **not** introduce a separate editable `/proposals` resource or mutable "latest terms" table. A correction to descriptions, assumptions, exclusions or **any** commercial term MUST produce a new **immutable scope revision**, including text-only edits with unchanged service/quantities. It MUST invalidate pending/current approvals and exact-revision export, require a fresh deterministic estimate and a separate reviewer decision. HTTP clients cannot mutate approved revisions in place.

The existing estimate request `POST /v1/projects/:id/estimates {"scopeRevision":N,"catalogVersion":V}` stays unchanged; metadata affects **binding and review freshness**, not `unitPriceMinor`, computed line totals or catalog provenance. A human owns text, but an untrusted brief or model cannot silently write commercial commitments. If terms contradict catalog-derived total, the UI must show both and request human correction; do not invent a model-based pricing override. `POST .../reviews` and `POST .../approve` keep existing revision body/response shape. Same current-revision constraints and separation-of-duties apply.

`GET /v1/projects/:id` includes the normalized metadata under `latestScope`. `GET /v1/projects/:id/exports/:revision` retains `{projectId,revision,currency,totalMinor,markdown}` and adds `proposal` read-only; `markdown` MUST render descriptions, overview, assumptions, exclusions and commercial terms **only from the exact approved scope revision**, alongside the authoritative estimate and reviewer provenance. An unapproved, superseded or wrong-revision export MUST fail `409 APPROVAL_REQUIRED` or `409 STALE_REVISION`; never silently export an older approved version as current. HTML-capable preview must sanitize user text; no auto-sends.

DB requirement: persist metadata atomically within immutable tenant+project+scope revision (and each line's description in immutable child row, or an equivalently constrained immutable snapshot). Preserve old rows through a forward-only migration and normalize absent values. Existing DB triggers rejecting UPDATE/DELETE and appended children apply to new fields. Ensure current-quote transaction checks cannot race a metadata/scope/catalog edit, including during export, and include metadata in returned replay response/audit revision binding. Test text-only revision invalidation, old request defaults, exact Markdown snapshot, attempts to edit terms in SQL, simultaneous review/change, prompt-injected terms, and restore fidelity.

## 5. Trusted tenant and initial owner: CLI, not HTTP registration

There is **no** `POST /v1/tenants`, public signup, anonymous role bootstrap, developer backdoor, or client-issued membership. Define a host-only administrative CLI command:

```sh
scopehatch-admin tenant create --tenant-id studio-example --owner-sub oidc-subject-from-trusted-issuer
```

The first execution uses a separately secured provisioning/migration DB identity, never the runtime API connection (`scopehatch_app` is non-superuser/NOBYPASSRLS). Require explicit configured OIDC issuer confirmation; the `owner-sub` is the exact verified issuer `sub` that will later be authenticated by API. Do not derive subjects from display names or email. If issuer can change, support an explicit administrative migration, not silent duplicate identity. CLI must refuse placeholder/missing issuer and an unrecognized caller environment. No fixture/test issuer or predictable seed actor may be provisioned into a customer DB.

Transaction: create `tenants(id)` plus `memberships(tenant_id,principal_id,roles=['owner'],active=true)` atomically; nonblank validated IDs, restricted uniqueness. Safe, intentional identical reruns are idempotent; if tenant already belongs to a different owner or has conflicting state, return a nonzero exit with no partial writes. No automatic model policy, budget, catalog, user invites, or changes to an existing tenant's owners. Command should have `--help` and a no-secret `--dry-run`; logs show only operation ID/tenant and safe outcome, not credentials or raw JWT. Successful exit proves DB commit, **not** browser authentication. Verify login separately with signed OIDC token and trusted membership lookup.

Packaging target: `tools/admin/**` executable entrypoint; any root bin/script or Compose wiring is reserved for integrator, not parallel workers. Protect admin connection material, deny SQL access via web containers, document offline invocation/credential rotation and exit codes `0` successful/idempotent, `2` input/config invalid, `3` conflict, `4` DB unavailable. No role-bearing token/tenant fields may be accepted by regular API endpoints.

## 6. SDK / Vue parity (one server authority)

New SDK methods (naming is normative; keep all existing Sprint 01 methods):

```ts
createCatalog(
  input: {baseVersion:number;currency:string;services:Service[]},
  options: WriteOptions
): Promise<Catalog>;

listProjects(
  options?: RequestOptions & {cursor?:string;limit?:number}
): Promise<ProjectPage>;

// createScope input is extended; old callers remain valid:
createScope(
  projectId:string,
  input: {deliverables:Deliverable[];unknowns:string[];proposal?:ProposalMetadata},
  options:WriteOptions
): Promise<Scope>;
```

SDK sends `POST /v1/catalogs` and unwraps `catalog`. It sends `GET /v1/projects` and retains the `ProjectPage` envelope. It forwards optional proposal/line description rather than silently stripping them (current SDK maps only four line keys). Preserve injected transport, token provider, optional verified-workspace selector, abort/timeout, bounded read-only retry and **explicit idempotency key** for writes. No SDK admin/provisioning client. SDK must not locally compute privileged status/price/review decisions.

Vue HTTP adapter `ScopehatchApi` gains `createCatalog(body)` and `listProjects(options?)` with the same response types. Existing `catalogs()`/`project()`/`createScope()` can keep their established names/signatures but must pass the same optional fields and use the same backend. UI: first-run "no catalog" -> owner-only catalog creator; project index with next-page navigation and truthful statuses; editable proposal text with visible unsaved/dirty warning and explicit revision creation; text-only changes trigger re-estimation/review; read-only approved artifact preview; no optimistic approval. Hide owner controls from unauthorized users **and** handle server 403. Test keyboard/accessible labels, failure/replay/empty states, and session expiry. Demo fixtures must be explicitly labeled; do not substitute them for real API release evidence.

## 7. Contract crosswalk: observed main vs Sprint 02 target

| Surface (main `e8bbfca`) | Confirmed current behavior | S02 work / compatibility gap |
|---|---|---|
| `apps/api/src/server.ts` | `GET /v1/catalogs` only; no `POST /v1/catalogs` or `GET /v1/projects`. Strict scope schema disallows metadata. | Add endpoints and optional schema keys; existing paths unchanged. |
| `apps/api/src/core.ts` + `ports.ts` | Project creation hardcodes `draft`; read goes through DB, review/export already revision-guarded. Port `Project.status` typed only `draft`. | One derived status type across response/index; exact additional shapes. |
| `packages/persistence/index.mjs` | `createCatalog` exists; DB allows owner **or operator**; `getProject` derives `draft/blocked/ready/pending/approved`; no list; scopes drop text metadata. | Tighten owner privilege, tenant cursor listing, persist revisions. |
| `db/migrations/001–005` | Tenant/RLS/composite FKs, immutable rows, full catalog versions and live inference ledger exist. | Forward migrations + direct SQL permission tests, never rewrite 001–005. |
| `apps/web/src/api.ts` / `types.ts` | No list/create catalog or proposal fields; dynamic workflow shown in a single project. | Implement corresponding calls/views. |
| `packages/sdk/src/client.ts` / `types.ts` | Existing typed v1; `createScope` strips unknown optional line fields. | Add typed methods, forward metadata; keep signatures. |
| `src/domain.mjs` | Deterministic money, proof/evidence rules and independent review; no proposal metadata. | Preserve price/approval behavior; explicit integration-owned domain adapter/change if necessary. |
| `deploy` / `docs/operations` | Single-host Compose, migration, DB, API/web health and optional Ollama/BYOK. | Provisioner exposure, restore rehearsal, first-run flow. |
| `tests/evaluations` | Fixture and optional live adapter; no CI real paid-model evaluation. | Evidence-based real-model evaluation and API workflow checks. |

All SDK and web additions remain **proposals until implemented/tested**. Historical `AGENTS.md`, `README.md`, `docs/10-current-implementation.md` describe the initial kernel and are **not up-to-date build-status evidence**; these files are intentionally not edited by this contract PR. Actual main CI evidence and go/no-go are tracked in `docs/13-sprint-02-release-gates.md`.
