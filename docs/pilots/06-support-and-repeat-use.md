# Support burden and recurring-use template

Use **real observations**, not filled-in examples. Intended for optional consenting operator follow-up; don't send unsolicited reminders or gather usage from third-party tools without permission.

## Session support log

| Date / study ID | Task / case | Category (setup/auth, catalog, scope, review, export, privacy, other) | Operator-visible symptom / safe error code | Assistance minutes (staff active time) | Resolved? by whom? | Repeat / novel issue | Private ticket reference |
| --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | |

Count synchronous help, debugging and manual administrative configuration separately. Log staff handoffs and repeat failures; avoid collecting raw JWTs, customer briefs, DB dumps or unredacted exception traces. If the task is not completed, retain the unresolved reason. If authorization or tenant leakage is suspected, stop and escalate privately.

## Weekly repeat-use ledger (suggested 2–4-week observation window)

Each week, record **eligible operators**, **eligible new briefs**, and **voluntary** usage. Count only new briefs handled for real decisions in an *approved* environment; fixture resets and rehearsed repeat cases do **not** count toward customer adoption.

| Week starting (ISO date) | Eligible operators | Eligible newly permitted briefs | Operators who returned **unprompted** | New briefs created in Scopehatch | Ready scopes | Independently approved current drafts | Current draft exports | Unsupported/unsafe events | Support minutes | Evidence quality / missing-data notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | | |

**Definitions:**
- **Eligible operators:** consented working operators with access to an approved, functioning environment; include those who didn't return. Record outages and opt-outs, don't drop them without explanation.
- **Unprompted return:** operator brought a *different new eligible brief* without facilitator chasing. Ask once for a follow-up interview if consented, but distinguish prompted demonstrations from unprompted use.
- **Eligible briefs:** briefs permitted under privacy controls and in product scope. Keep counts even when they were ultimately handled in spreadsheets.
- **Ready scopes:** deterministic catalog-based estimates with no blockers; not the number of AI completions.
- **Approved current drafts:** distinct authorized human reviewer approved the exact current bound version; historical/superseded approvals excluded.
- **Current exports:** outputs of exact currently approved revisions, **unsigned**, not client sends or accepted proposals.
- **Unknown usage or absent analytics:** mark `unknown/not collected`, never numeric zero. Do not infer inference spend when no provider reported it.

## End-of-pilot readout — leave blank until observed

| Indicator | Formula / decision rule | Observed result |
| --- | --- | --- |
| Activation | # independently completed correct synthetic tasks / # attempted, assisted separately | ______ |
| Correctly blocked work | # appropriate blocks / # cases that required a block; note missed blockers | ______ |
| Safety | Counts of unauthorized approvals, ungrounded catalog prices and stale exports (**zero required**) | ______ |
| Draft quality | Sum of applicable human quality points / sum of applicable maximum | ______ |
| Review friction | Human reviewer active seconds and correction count per eligible case | ______ |
| Tool support load | Active support minutes / attempted and then / successful cases; include setup separately | ______ |
| Voluntary recurring use | # eligible operators with unprompted new brief / # eligible operators, per week | ______ |
| Proposal completion | # exact current approved drafts / # permitted eligible briefs; show blockers and cancellations | ______ |
| Workflow preference | Count participants selecting spreadsheet/doc, Scopehatch, mixed or uncertain, with reasons | ______ |
| Commercial demand | **Not measured** unless separately asked under explicit research protocol; no inferred willingness to pay | ______ |

## Go/iterate/stop discussion (not an automatic launch gate)

Review security/release gates before any broader exposure. Continue a strictly scoped pilot only if the required controls were exercised and the **safety-failure count is zero**; investigate any unauthorized approval, fabricated catalog price, cross-tenant exposure or stale export before expanding. Iterate on measured correction hotspots and friction; do not manufacture favorable conversion, interview quotes or willingness to pay. Repeated self-initiated use on subsequent briefs is stronger evidence than the number of model calls or one successful demo.

Publish aggregates only with permission and denominators, while storing consent forms and raw support notes privately.
