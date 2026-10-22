# Operator onboarding — short checklist

**Facilitator/studio operator:** tick only after observing the step. The *default* is fictional demo work; no production keys or proprietary client data are required.

- [ ] Record anonymous study ID, date, pilot host/version or `main` SHA, **fixture/demo vs authenticated self-host**, and whether a facilitator is present.
- [ ] Choose [one of five entirely fictional scenarios](../../examples/pilot/README.md). Confirm participant knows this is a rehearsal, not a real client request.
- [ ] For local rehearsal, start `npm run dev --workspace @scopehatch/web` from a repo with dependencies installed. Clearly identify the **synthetic fixture** banner and its non-persistent actors. Do **not** copy fixture JWTs/accounts into a real deployment.
- [ ] For gated self-host mode only, host administrator has separately configured external trusted OIDC; provisioned the first tenant and verified subject via [first-run runbook](../first-run/README.md); arranged distinct human author and reviewer; verified backup and retention. Facilitator does not handle or record anyone's bearer token, secret or admin DB URL.
- [ ] Owner identifies rate currency and units; in the synthetic example, publish the `catalog` values in `examples/pilot/scenarios.json` as a **complete immutable replacement**. Rate cards are fictitious and are not recommended market prices.
- [ ] Operator locates project index, creates a named project, pastes **original brief unchanged**, and can reopen it without retaining/copying the project ID.
- [ ] Operator understands `source: brief` requires a literal excerpt from the preserved brief, while `source: manual` must identify an explicitly supplied clarification; AI suggestions are advisory only.
- [ ] Operator can identify `null` quantities, unknown requirements and estimate blockers. Never guess counts, prices, client consent, acceptance criteria or schedules.
- [ ] Operator recognizes `proposal.overview`, assumptions, exclusions, commercial terms and per-line descriptions as human-authored, **revision-bound** text. Any text change needs a new revision.
- [ ] Author and reviewer are two different **authorized human principals**. A fixture persona switch is a usability simulation, not security proof. Approval only follows a current **ready** estimate; output is an **unsigned Markdown draft**, never a signed/sent quote.
- [ ] Participant knows how to stop, decline recordings, ask for help and report errors without sharing credentials. For customer-derived content, consent/privacy gate in [02](02-consent-and-privacy.md) must already be satisfied.
- [ ] Ensure a blank [observation sheet](04-observation-sheet.md), comparison form and support log are ready. Do not enter invented test outcomes.

**Stop the session** rather than workaround authorization if tenant separation, price authority, approval binding or privacy is uncertain. If the reviewer cannot be configured, mark approval/export **not tested**; do not self-approve.
