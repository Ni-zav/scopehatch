# Consent, minimization and privacy gate

**Use synthetic briefs by default.** This is an operational checklist, not legal advice or a statement of compliance. A studio's designated data owner decides whether any real material may be processed.

## Before collecting or pasting a real brief

- [ ] **Right to use:** identify the client/studio permission holder and document explicit permission for this specific limited evaluation. Verify existing confidentiality agreements permit use of this tool; anonymization alone is not permission.
- [ ] **Purpose and scope:** describe exactly which brief text, project metadata, citations and final draft will be viewed by whom, for which tasks and for how long. Exclude source CAD, personal IDs, passwords, contact lists and commercial secrets unless separately necessary and authorized.
- [ ] **Participant consent:** give a plain-language explanation of voluntary participation, whether notes or screen/audio/video recording will occur, who sees recordings, how to decline, and the agreed withdrawal/deletion request process. Obtain separate opt-in for recording; do not infer it from participation.
- [ ] **System and processors:** specify self-host location, access roles, backups/logs and any external provider. Keep model inference **disabled** unless the data owner specifically permits a named provider, data destination and processing conditions. No unsolicited uploads to public model demos.
- [ ] **Account and workspace:** verify trusted OIDC identities and memberships before logging in; restrict operator/reviewer access to the permitted workspace. The host holds real secrets outside recordings, documents and code.
- [ ] **Minimize and redact:** replace names and addresses with neutral labels only with authorization; remove client contacts, addresses, specific floor plans, passwords, API keys, tokens, unique identifiers and hidden metadata. Preserve needed quantity and evidence text exactly *within the approved redacted brief* so spans remain checkable. Document any lost context.
- [ ] **Retention:** agree a written deletion/retention date and storage location for study notes, exported drafts, logs, recordings, DB and backup copies, plus responsible owner and how deletion requests are handled. Do not commit real session data or secret-bearing files.
- [ ] **Access and sharing:** limit artifacts to named study staff; no public links, GitHub issues/PR attachments, external survey systems or unsecured messaging containing real briefs or tokens.
- [ ] **Incident path:** identify internal contact and stop/delete/escalate procedure for an unauthorized upload, cross-tenant exposure, unintended provider call or leaked credentials. Do not attempt to conceal failures.

## Private decision record (copy into restricted storage, never GitHub)

| Item | Required entry |
| --- | --- |
| Study ID, permission holder and date | ______ |
| Permitted documents/fields | ______ |
| Approved host, processor/model and destination, or **offline only** | ______ |
| Named roles allowed to view source/export | ______ |
| Recording opt-in: yes/no, separate from participation | ______ |
| Retention date, backups and deletion owner | ______ |
| Consent artifact location (private reference only) | ______ |
| Outcome: APPROVED FOR NAMED DATA / SYNTHETIC ONLY / DECLINED | ______ |

If any required permission or environment control is absent, select **SYNTHETIC ONLY** and use [fictional scenarios](../../examples/pilot/README.md). Do not ask a participant to provide private login credentials, raw brief files, invoices or commercial catalog rates just to complete the study.

**Reporting:** publish only aggregates, anonymized observations authorized for release, task-level counts and qualitative *facilitator-authored* findings. Never turn test-script text into customer quotes or imply these cases represent actual users.
