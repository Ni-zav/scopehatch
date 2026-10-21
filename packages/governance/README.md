# @scopehatch/governance (Sprint 01)

Governed, tenant-scoped **inference routing and accounting primitives**. This package is not a provider adapter, a production gateway, a database, or a verified auth boundary. It never sets catalog pricing or approvals.

```sh
cd packages/governance
npm run build
npm test
```

Requires Node.js >=22, no external dependencies. `build` syntax-checks ESM sources; the `.d.ts` file is the integration type contract. No root workspace/CI configuration is changed by this workstream.

## Policy and accounting model

- **Trusted inputs only:** `tenantId` comes from verified membership context, `policy` from a tenant-scoped policy store, `candidates` from a tenant-scoped model registry. A client-supplied tenant/policy/price/BYOK key is never authoritative. Never serialize raw credentials as candidate fields; the call adapter resolves `providerId` from secure tenant-scoped credentials after routing.
- `policy`: `{ tenantId, currency, allowedModels:[{providerId,model}], allowedResidencies?:string[] }`. Registry candidates: `{tenantId,providerId,model,enabled,capabilities,contextWindow,residency,currency,price:{inputPerMillionMinor,outputPerMillionMinor},priority?,timeoutMs?}`. Only matching tenant/model, capability, context, residency, currency and healthy circuit is eligible; ties sort deterministically. Failure: `NO_ELIGIBLE_PROVIDER` (503).
- `reserve`: requires `{tenantId,idempotencyKey,requestDigest,policy,candidates,capability,inputTokens,outputTokens,residency?}`; SHA-256 `requestDigest` must bind a canonical normalized billable request and exclude raw content from logs. Reserves max token cost before provider dispatch, chooses an eligible affordable route, and denies exhausted quota (429).
- Money: **decimal strings of integer currency minor units** (safe from JS float rounding), token tariffs per million tokens in minor units, aggregate charge rounded upward once with `BigInt`; mixed currency rejected. No floating values, no negative quantities or unsafe token counts. Configured tariff and budget are business configuration; model-generated content cannot change them.
- Reservations: `reserved -> dispatched -> settled` or `dispatched -> unknown -> settled` upon late reconciliation. `reserved -> released` is allowed before dispatch; after dispatch release requires **trusted, explicit confirmation that every attempt was unbilled**. An unknown usage response (including missing/malformed token counts, timeout, ambiguous cancellation) **retains the full hold** and `costMinor:null` until trusted usage or invoice reconciliation arrives. An invoice with known cost but missing tokens can settle the cost while preserving `usage.status:'unknown'`.
- Cost above reservation can be recorded because the provider may already have incurred it. It may put the tenant above configured limit: block new reservations and flag overage in the application/operations integration, never erase genuine charges.
- `executeGoverned` performs the reserved call through a trusted callback. Max 3 attempts. Retry only errors explicitly marked `retryable:true, nonBillable:true` by trusted adapter logic, with capped exponential waits and circuit gate. Timeout, ambiguous errors and cancellation stop immediately and retain unknown usage; they are **not** blindly retried. A duplicate request returns `status:'replayed'` without making another provider call. The in-process breaker is advisory only, not a distributed concurrency limiter.
- `safeTrace` projects a fixed allowlist, pseudonymizes tenant ID, excludes user text, raw error messages, API keys and arbitrary metadata. Provider outcomes must be emitted by the host observability integration; this module does not send telemetry.

## Transaction-capable storage port (required for real usage accounting)

`withTenantTransaction(tenantId, async tx => result)` MUST commit/rollback **atomically** and serialize account-budget changes across *all* processes. Inside the transaction, `tx` has these synchronous (or adapt to awaited equivalents in an integration shim) methods:

| Transaction method | Required result/behavior |
| --- | --- |
| `getAccount()` | tenant-scoped `{currency,limitMinor,heldMinor,spentMinor}` or `null` |
| `putAccount(account)` | atomic update of tenant budget totals |
| `getReservationByKey(idempotencyKey)` | existing reservation or `null`, scoped to transaction tenant |
| `getReservationById(reservationId)` | existing reservation or `null`, scoped to transaction tenant |
| `putReservation(record)` | insert/update tenant-bound record atomically, preserve status and pricing snapshot |
| `getEvent(eventId)` | prior tenant-scoped immutable event or `null` |
| `putEvent(event)` | insert immutable event; uniqueness of `(tenant_id,event_id)` |

Implement in PostgreSQL with `BEGIN`/`COMMIT`, `SERIALIZABLE` isolation **or** a tenant budget row locked with `SELECT ... FOR UPDATE`, and transactional updates of reservation, account totals and idempotency events. Enforce tenant RLS and composite tenant foreign keys on budget, reservations, and events, with transaction-local verified tenant identity and `FORCE ROW LEVEL SECURITY` as appropriate. Set the tenant context on the **same dedicated transaction connection**, never reuse an untrusted session context. Require unique `(tenant_id,idempotency_key)` for reservations, unique `(tenant_id,reservation_id)`, unique `(tenant_id,event_id)` for accounting events. Database unique-constraint conflicts or serialization retries must be retried in bounded fashion **around the full transaction**, not by duplicating a provider call. Hash/dedupe of request intent is checked before new holds. Store authoritative model price snapshot in each reservation. Prevent lost updates, replayed settlement, cross-tenant event lookup and negative budget totals. The adapter must not expose a transaction callback whose effects are partly committed.

**Important:** the port currently assumes synchronous transaction methods; PostgreSQL query APIs are async. The integrator can provide a preloaded synchronous transaction facade while row-locked, or introduce an awaited port in a dedicated integration PR and update callers/tests together. Do **not** implement a fake sync facade by issuing unawaited SQL. This is a specific integration change, not a claim of existing DB support.

`FakeGovernanceStore` at `@scopehatch/governance/testing` deep-clones and serializes transactions **only within one JS process**. It is **not crash-safe, durable, multi-instance-safe or proof of PostgreSQL transactional correctness**.

## Remaining integrations

1. Persistence worker: actual Postgres migrations, RLS, unique keys, durable budgets/reservations/events, row locks/serialization, transaction retries, version/tenant constraints and reconciliation scan for aged unknown holds. Align async port atomically as noted above.
2. API/auth worker: verified OIDC membership context, tenant-specific policy/model registry, administrative budget policy and idempotency `requestDigest` generated from normalized request, 429/503 error mapping, no user-supplied provider identity as authority.
3. Extraction worker: trusted OpenAI-compatible/Ollama adapter callback, content-safe credential resolution and abort/deadline handling, provider token metering or explicit unknown, provider billing/error classification and provider request IDs. The adapter MUST NOT mark ambiguous network failures `nonBillable`.
4. Integrator: wire the suggestion endpoint through reserve -> markDispatched -> provider -> settle; add tenant-safe tracing and audit/outbox events, explicit pending/unknown spend UX and operator reconciliation from invoices, replay semantics and recovery for stranded `dispatched` records.
5. Integration testing: real PostgreSQL two-connection contention, process crash after dispatch, ambiguous timeout, duplicate request from independent API instances, cross-tenant RLS, authoritative invoice/billing reconciliation and rollback. None is verified by these in-memory tests.

**Proposed contract change:** Formalize this package's exact ledger port shape, async DB transaction contract and error mapping in a future dedicated shared-contract integration PR. No shared contract is edited here.
