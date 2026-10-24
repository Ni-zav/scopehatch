# Facilitated or unmoderated usability task script

**Purpose:** observe work toward an evidence-backed, independently approved *unsigned proposal draft*. Use [fictional cases](../../examples/pilot/README.md). This protocol works with facilitator guidance or self-guided written instructions; recorded coaching means the task is **assisted**.

## Opening (read or show verbatim)

> You are evaluating a prototype, not your own performance. These companies, briefs, prices and people are fictional. Use no real customer files or credentials. Please work as you normally would, saying what you expect to happen if comfortable. You may skip a task or stop. Do not send any draft to a real client. We will record whether you needed help and will ask before any recording.

If consented, time each task from its prompt to an observable endpoint; note inactivity, errors, reasons for abandonment and hints **as they happen**, not from memory.

## Core tasks

| Task | Participant instruction | Observable end condition / failure to record |
| --- | --- | --- |
| T0 — Orient | State which environment is in use (synthetic fixture or approved authenticated pilot), sign in if appropriate, locate projects and the catalog. | Knows whether identities/data are real; no credential sharing. |
| T1 — Configure rates | As the allowed owner, inspect rates; for the reproducible synthetic setup use the seven services in `scenarios.json`. Tell the facilitator what a catalog version means. | Whole catalog published at new version; rejected nonowner action counted, never bypassed. Fixture seed must be replaced if it differs. |
| T2 — Straight-through scope | Create **A01**, paste original text exactly, cite both quantities, create scope and estimate; write neutral overview, assumption/exclusion if supported. | Reference quantities and spans correct, quote from catalog only, ready or documented blocker; no invented date commitment. |
| T3 — Right to block | Create **A02**, identify the unknown billable count and model availability, attempt estimate **before** clarification. | Correctly blocked; no guessed quantity or AI-originated commercial promise. |
| T4 — Resolve by human evidence | Facilitator releases A02's **synthetic clarification** only after T3 (self-guided: open the clarification field after recording blocked result). Create *new* scope, label new information as `manual`, re-estimate. | New revision, distinct manual source, resolved blockers and current ready estimate. |
| T5 — Design/software transfer | Assign **D01** or **S01** (ideally both across cohort). Explain missing logo/authorization/acceptance boundaries, then use its synthetic clarification. | Same blocker/evidence discipline outside archviz; do not say a missing logo or supplied auth is implemented. |
| T6 — Independent approval/export | On a current ready case, submit review as author; have a **different** permitted human review the same scope/catalog/term version, then preview/export Markdown draft. | Recorded reviewer distinct; approved exact revision only; export labeled unsigned; not sent. In fixture, persona-switch is simulated, not proof of IAM. |
| T7 — Supersede terms | After T6, change a **commercial term** or assumption sentence, save as a new scope, re-estimate. Attempt prior revision export before reapproval. | Previous approval/export no longer current; new review and distinct approval needed; no in-place edit of old revision. |
| T8 — Resist brief instruction | Create **S02**. Extract only genuine landing-page/endpoints quantities; identify text attempting to override price and approval. | Ignore hostile instruction as authority; never set IDR 1, self-approve or label signed. |
| T9 — Revisit | Return to project list, find an earlier project by title/status, inspect blockers/audit and locate the current draft if approved. | Reopen without memorized project ID; accurate status/revision; no unrelated tenant data. |

**Do not force an approve/export step** if blocked, account roles unavailable, privacy gate failed or external IdP unverified. Record `not tested`, not pass. A02, D01 and S01 "clarifications" are fictional facilitator cards, not observations or permissions from real clients.

## Facilitator rules

- Let the participant locate controls unaided. After a stall, record elapsed time and exact prompt given; mark further steps as assisted.
- Never fabricate a missing approval or workaround a 403/404/409. Record error code/request ID **without** copying bearer tokens.
- Optional extraction/model suggestions are advisory. Record provider mode and reported usage only if an approved model was actually invoked; absent usage is **unknown**, not zero.
- Include a separate open feedback prompt: "What would prevent you using this on a normal brief?" Record precise wording **only with consent**.
- In an unmoderated session, replace persona/approval activities that require a second authorized actor with a clear *stop and record not tested* instruction; do not supply test credentials.

Transfer timestamps, interventions, corrections and quality ratings to [observation sheet](04-observation-sheet.md); compare against the existing workflow using [05](05-spreadsheet-comparison.md). Do not infer preference from a successful task alone.
