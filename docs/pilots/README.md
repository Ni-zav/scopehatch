# Scopehatch Sprint 02 — small-studio pilot kit

**Status:** a study protocol and fictional exercise data, **not** evidence of tested customers, demand, time savings or deployment security.

## Decision this pilot informs

For studios of roughly 2–20 people doing architectural visualization, design or software services: does an operator reliably turn an incoming brief into an evidence-backed, catalog-priced, independently reviewed **unsigned proposal draft**, and choose to use the tool on the next brief without prompting? This implements the measurement intent in [business validation](../07-business-validation.md), not an expansion into CRM, automated quoting or hosted billing.

## Paths through the kit

1. **Safe rehearsal (default):** run the separately labeled local Vue **synthetic fixture** described in [the web README](../../apps/web/README.md). It includes fake actors, seed data and rate cards, resets on refresh and has **no real identity or persistence**. Copy a fictional brief from [the scenario deck](../../examples/pilot/README.md) into a new project. The fixture does not import JSON automatically. For comparison consistency, have its synthetic owner publish the exact seven-service fictional catalog manually, or log any deviations. A fixture success proves UX rehearsal only.
2. **Restricted self-hosted pilot (separate approval):** prerequisite is operator-approved single-host deployment, trusted external OIDC and distinct real owner/operator/reviewer memberships, protected DB and confirmed backup/restore as described in [release gates](../13-sprint-02-release-gates.md). Start with *only synthetic briefs*, private network and optional model use **off**. Do not interpret CI's signed synthetic OIDC or mock inference as a real-studio security qualification.
3. **Consent-based customer workflow (gated):** only after the [privacy decision record](02-consent-and-privacy.md), access controls, retention location and permitted processors have been explicitly approved. A redacted excerpt still needs appropriate authorization; otherwise stick to fiction. Do not publish actual case data in GitHub.

Follow [operator onboarding](01-operator-onboarding.md) → [consent and privacy](02-consent-and-privacy.md) → [usability tasks](03-usability-script.md) → [observation sheet](04-observation-sheet.md) → [spreadsheet/doc comparison](05-spreadsheet-comparison.md) → [support and repeat-use log](06-support-and-repeat-use.md).

## Suggested study design — not reported results

Recruit 5–10 **actual studio operators** with varied roles, not acquaintances acting as invented customers. Run the synthetic tasks first (one uncomplicated case, a blocked case, a revision/export case, and an adversarial case). When authorized, plan 10+ consented real-ish briefs across operators; record how many could not be used. Compare with the **same** services/rates and human reviewer using their existing spreadsheet/doc process. Alternate task order where possible, note whether the participant already knows Scopehatch, and allow an opt-out. Record observable behavior, corrections, elapsed time, blockers, support and return use; never backfill blanks with fabricated observations.

**Required gates before interpreting a release:** no unauthorized approvals, no ungrounded binding prices, no stale-revision exports; manually verify current exact scope/catalog/term binding and correct evidence. A blocked estimate can be the *right* outcome. Real-world quotation, signature, legal terms, customer send and invoicing are outside this prototype.

## Handoff package

Use anonymous study IDs (e.g., P01/S01), run date, app **commit SHA**, fixture vs real environment, scenario ID, catalog version and model mode. Keep completed sheets, screen recordings and unredacted data in a studio-controlled restricted location, **never this repository**. Report numerator/denominator and missing observations. Distinguish a UI facilitator intervention from tool completion, and omit model latency/cost if no provider was actually run.

## Reproduce synthetic content validation

From repository root with Node.js 22+ (no API, network, secrets or DB required):

```sh
node examples/pilot/validate.mjs
```

The validator exercises catalog, evidence spans, scope quantities, initial blockers, and documented synthetic clarification transitions against the **actual pure domain kernel**. It does not certify browser UX, authorization, OIDC, PostgreSQL, model accuracy, privacy compliance or customer preference.
