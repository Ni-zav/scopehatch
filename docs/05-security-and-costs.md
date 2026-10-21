# Security, trust boundaries and economics

## Trust boundaries
Raw client briefs, uploaded files, retrieved text, tools, model output and agent requests are **untrusted**. A workpack cannot grant itself privileges. Treat provider response schema validity separately from grounded factual accuracy.

- Principals from validated OIDC/JWT issuer, audience, expiry and signature. No client-supplied role/tenant as authority.
- Enforce tenant ownership on each row and transaction; test PostgreSQL RLS and query scoping.
- Bind reviews to exact immutable scope and catalog versions; no implicit approvals.
- Restrict outgoing requests: provider allowlist, no arbitrary tool URLs, timeout, size cap, redirect checks and SSRF prevention.
- Encrypt secrets at rest, redact logs; separate BYOK keys per tenant; never send user secrets in traces.
- Use DB transactions and unique idempotency constraints for budget reservation and jobs.
- On timeout or unclear usage, mark spend unknown/reserved until reconciliation; no automatic free assumption.
- Test prompt injection that asks model to alter rates or mark itself approved.

## Money arithmetic
Amounts are safe integers in currency minor units. No floats for pricing. Catalog rates, version and currency are authoritative. Reject overflow and mixed currencies. Production adds exact decimal/BigInt-safe serialization.

## Economics
For each tenant track base hosting, compute, provider charges (unless BYOK), storage, telemetry, support and incident burden. Track quote approval rates and repeat usage before pricing optimization. BYOK may reduce our inference exposure but does not guarantee margin.

## Go-live security gate
External audit of tenant and provider boundaries, rollback, backups, GDPR/PDPA-style privacy assessment where relevant, incident response and realistic billing validation; don't label the five-day demo production secure.