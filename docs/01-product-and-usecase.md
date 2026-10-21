# Product and first customer

## Who it serves
Owners and operators of small (roughly 2–20 person) architectural-visualization, design, and software-service studios. Client briefs arrive by email or chat with vague quantities, missing acceptance criteria and ambiguous deliverables. A wrong quote is more expensive than a missed AI completion.

## First promise
Convert a client brief into a traceable **draft**: deliverables, quantities, evidence from the brief, unknowns, suggested clarification questions, a deterministic estimate based only on a studio-owned rate catalog, and a human approval step before export.

### Core sequence
1. Workspace owner creates a versioned service catalog (currency and fixed integer minor-unit prices).
2. Operator pastes the brief, stores the unmodified source, and creates a project.
3. Operator edits an extracted scope; unknown quantities and unsupported claims are explicit.
4. Rule engine computes a quote or returns blockers; model text is never authoritative for pricing.
5. Scope and catalog revisions are bound to a review. Another authorized reviewer approves.
6. Approved exact revisions produce a proposal draft and an audit record. No outbound send in MVP.

## Explicit non-goals
Not a general CRM, signed quotation system, billing service, fully autonomous sales agent, or financial advice. No fabricated model benchmarks, savings, customers or revenue. No sending email or changing external systems without an explicit future permission path.

## Agent and human parity
UI, REST clients and future MCP workpacks hit the same server authorization and audit path. Actors can propose and review only within their role. Agent access is not a route around human approval.

## First success criterion
A new operator can provide a synthetic brief, edit missing fields, obtain an accurate catalog-based estimate, get independent approval, and export the exact approved revision. A malicious or cross-tenant caller fails closed.