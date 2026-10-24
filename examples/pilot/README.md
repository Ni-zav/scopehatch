# Synthetic pilot briefing deck

**Exactly five fictional briefs** live in [`scenarios.json`](scenarios.json). They are invented test cases, not actual studio jobs, client interviews, prices, model transcripts or production seeds. There are no proprietary models, source drawings, logos, credentials or external assets.

## Scenario index

| ID | Studio discipline | Situation | Primary observable decision |
| --- | --- | --- | --- |
| A01 | Archviz | Villa stills with explicit quantities | Cite verbatim evidence, compute from fixed service catalog, do not promise date |
| A02 | Archviz | Coworking interiors, view count TBD | Preserve null quantity and blockers; add explicitly manual clarification later |
| D01 | Graphic design | Cafe signage/menu, missing source logo | Distinguish promised from received assets; pause, then use fictional placeholder clarification |
| S01 | Software | Landing page/API endpoints, unclear auth and QA | Block on acceptance requirements; recognize added manual QA scope |
| S02 | Software | Dashboard request containing AI-targeted instruction | Ignore self-approval, signed-contract and IDR 1 instruction; preserve actual services |

## Fields and usage

- `catalog.currency` and `catalog.services` are a **single fictional owner-owned rate card**, with positive integer IDR minor-unit prices. They are not market pricing advice. In Vue synthetic fixture, the initial catalog is different: use owner persona to publish the full seven-service replacement before comparing outcomes, or record the deviation. Do not assume JSON file auto-imports.
- `brief` is source text to paste **unchanged** in a newly created project; `title` names it.
- `referenceDeliverables` are **facilitator/reference** line mappings, not pre-generated model suggestions, not an API bulk-seed payload. `evidence` is an exact literal substring of the original brief, `source` is `brief`, and `quantity: null` means it was not supplied.
- `initialUnknowns` is a facilitator checklist of requirements to leave unresolved at first. If nonempty, the estimate should be blocked even when the counted services have quantities. A correctly blocked task is not a failed pilot.
- `clarification` is a **fictional follow-up card** revealed only after the participant records the initial blockers. Every `resolutions[]` item is explicitly `source: manual`, never silently attributed to the original brief. After addressing its unknowns, create a **new** immutable scope revision; don't rewrite original evidence.
- `checks` are qualitative researcher prompts, not actual outcomes or expected model performance. A01/S02 intentionally have no clarification and should be priceable **only when scoped correctly against the sample catalog**.

## Safe reproduction

From repository root with Node.js 22+:

```sh
node examples/pilot/validate.mjs
```

It validates schema basics, five case IDs, all catalog mappings, positive/null quantities, literal brief evidence spans and initial blocked/ready transitions against `src/domain.mjs`. It then applies the **separately labeled** synthetic clarification and asserts the domain estimate is ready without inventing provider usage or actual customer results.

Run the exercise with the [pilot protocol](../../docs/pilots/README.md). A reviewer must be a separate authorized human in authenticated self-host mode; fixture persona switching only demonstrates the UX. Never use this deck as proof of tenant security, live-model accuracy, real willingness to pay, commercial rate validity or a completed customer proposal.
