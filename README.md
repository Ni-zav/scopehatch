# Scopehatch

**From a messy request to approved work.**

> STATUS: product research and initial technical planning, compiled 2026-10-21. No app, live provider integration, benchmark, revenue, security certification, or paying customer exists yet.

Scopehatch is an open-source, self-hostable workbench for people and AI agents to turn ambiguous business requests into structured, evidence-backed, human-reviewed work. The first business workflow is **client brief → scoped requirements → rule-based estimate → clarification / proposal draft → review → export**.

It has two aligned surfaces: (1) a human operator's browser workbench; (2) programmatic REST/SDK/MCP access for authorized agents. Both go through **the same policy, budget, audit and execution primitives**. Its modular governed inference layer supports hosted BYOK and local models, without claiming to be a generic gateway better than established offerings.

## Primary persona and use case

Owner/operator of a 2–20 person **archviz, design or software services agency** that repeatedly receives poorly specified requests, spends time clarifying them, and risks underquoting or sending incomplete offers.

A *prospective* request: "Need exterior images and 12 interior angles for a new development. IFC and PDFs available. 4K output in two weeks. What's the price?" Scopehatch parses quantities and deliverables, flags missing assumptions and ambiguities, retrieves firm-specific service catalog rules, and proposes a quote with line-item evidence. A human edits and approves the draft. It never silently invents a binding price, sends messages, or changes external systems.

## Wedge, not ceiling

- **Initial business product:** service request intake, scope clarification, and proposal preparation (not full CRM, invoicing, or e-signature).
- **General-purpose platform:** versioned workpacks, model registry, tenant policy, approvals, task execution, evaluation, audit events, cost ledger, and an open API.
- **Second workpack:** synthetic support-triage and policy-QA demos inherited from the old governed inference lab; use to prove extensibility, not a parallel product launch.
- **Longer-term:** invoice exception review, customer support draft handoff, internal change approvals. Validate separately before building.

## Current repo proposal

GitHub: [`Ni-zav/scopehatch`](https://github.com/Ni-zav/scopehatch) (initialized 2026-10-21). Proposed license: Apache-2.0 for the core; paid **hosting/convenience/support** later. Name is working only; perform registry/mark/domain diligence before launch. One historical `scopehatch.site` registration was indexed, so no claim of worldwide uniqueness.

## Read order

1. [Product brief and personas](docs/01-product-and-usecase.md)
2. [Landscape and positioning](docs/02-market-and-positioning.md)
3. [MVP domain contract and workpack](docs/03-workflow-and-contracts.md)
4. [Technical architecture and deployment](docs/04-architecture.md)
5. [Security, economics and operating model](docs/05-security-and-costs.md)
6. [Five-day build plan and test gates](docs/06-implementation-plan.md)
7. [Validation, distribution and business model](docs/07-business-validation.md)
8. [Research source register](docs/08-sources-and-uncertainties.md)
9. [Repo bootstrap and governance](docs/09-repo-bootstrap.md) and [AGENTS.md](AGENTS.md)
10. [Original inference plan](docs/archive/inference-lab/README.md) for design-history details and broader Mekari-style engineering traceability. This archived plan is NOT the live product scope.

## Product rule

**An AI completion is not a business completion.** A request is finished only when required facts are grounded, deterministic constraints pass, responsible humans/agents have exercised their permissions, and the resulting artifact can be inspected or exported.

## Don't confuse planning with delivery

All endpoint examples, manifests, checkpoints and commercial terms are **proposed contracts**, not operational claims. If you implement a subset, advertise only the tested subset.