# AGENTS.md — Scopehatch contributor and coding-agent contract

**Current status:** planning pack. Do not claim features exist because specs mention them. Never create/push repos or deploy without explicit user request. Read README then docs/01, 03, 04, 05, 06, 09 before coding.

## North star

Build a usable client-brief → evidence-backed scope → rule-based estimate → human-approved draft workflow before generalizing. The governed inference layer is an enabling subsystem, not the primary user story. Keep capability modular so custom workpacks can reuse it without requiring the first vertical.

## Invariants

- Tenant-scoped auth checked at every route and worker step; alternate agent paths cannot bypass it.
- The model NEVER authoritatively sets fees, tax rates, or approvals. Use deterministic catalog rules for money.
- Deny execution when a claim has missing required evidence, a revision has changed, or review/policy is unresolved.
- Preserve model usage `unknown` when not reported; don't turn missing measurement into zero.
- No unauthorized external effects or sending. Never infer completion from successful HTTP response alone.
- No secret persistence in source, commits, logs, golden fixtures or traces. Never copy non-public SVEIN data into this project.
- Every implementation claim includes actual tests or screenshots; don't invent metrics.

## Method

1. Read task fixture and acceptance contract. Identify the minimal complete vertical slice.
2. Implement schema + domain tests before UI convenience.
3. Test cross-tenant access, missing money inputs, stale approvals, replays and malicious content.
4. Run formatting/typecheck/tests and describe what ran with concrete results; do not say green if not executed.
5. Keep changes modular, small, reviewed; docs must distinguish 'built' vs 'planned'.

## Negative requirements

Do not build 100 model adapters, generalized distributed scheduler, full CRM, auto-email, GPU cluster, pseudonomous multi-agent swarm, oversized workflow visual builder, scraped leads, unverified claims, or arbitrary third-party workpack execution for the MVP.

## Packaging and license

Plan for Apache-2.0 core, pending license audit. Separate community OSS and hosted operational convenience without intentionally weakening OSS security primitives. User will create `Ni-zav/scopehatch` later.