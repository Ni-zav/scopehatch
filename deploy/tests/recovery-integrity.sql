-- Fail with ON_ERROR_STOP if a synthetic restored database is incomplete or unsafe.
-- Must run on both the source and target disposable databases.
\set ON_ERROR_STOP on
DO $checks$
DECLARE invalid_count bigint;
BEGIN
  IF (SELECT count(*) FROM scopehatch.tenants) <> 2
    OR (SELECT count(*) FROM scopehatch.tenant_identity_issuers) <> 2
    OR (SELECT count(*) FROM scopehatch.memberships WHERE active) <> 4
    OR (SELECT count(*) FROM scopehatch.projects) <> 2
    OR (SELECT count(*) FROM scopehatch.catalog_versions) <> 2
    OR (SELECT count(*) FROM scopehatch.catalog_services) <> 3
    OR (SELECT count(*) FROM scopehatch.intakes) <> 2
    OR (SELECT count(*) FROM scopehatch.scope_revisions) <> 3
    OR (SELECT count(*) FROM scopehatch.scope_deliverables) <> 3
    OR (SELECT count(*) FROM scopehatch.estimate_revisions) <> 2 THEN
    RAISE EXCEPTION 'Missing tenants/catalogs/intakes/immutable scope revisions/quotes';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM scopehatch.reviews r JOIN scopehatch.estimate_revisions e
      ON (r.tenant_id,r.project_id,r.estimate_revision,r.scope_revision,r.catalog_version) =
         (e.tenant_id,e.project_id,e.revision,e.scope_revision,e.catalog_version)
    WHERE r.tenant_id='studio-a' AND r.state='approved' AND r.submitted_by='a-operator'
      AND r.approved_by='a-reviewer' AND r.submitted_by <> r.approved_by
      AND e.state='ready' AND e.total_minor=400000 AND e.currency='IDR'
  ) THEN RAISE EXCEPTION 'Approved export eligibility or reviewer separation lost'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM scopehatch.scope_revisions
    WHERE tenant_id='studio-b' AND project_id='b-demo' AND revision=2
  ) OR NOT EXISTS (
    SELECT 1 FROM scopehatch.scope_deliverables
    WHERE tenant_id='studio-b' AND project_id='b-demo' AND scope_revision=1
      AND quantity=1
  ) THEN RAISE EXCEPTION 'Immutable historical scope not retained'; END IF;
  IF (SELECT count(*) FROM scopehatch.audit_events
    WHERE action='seed.fixture') <> 2
    OR NOT EXISTS(SELECT 1 FROM scopehatch.audit_events
      WHERE action='proposal.approved' AND actor_id='a-reviewer'
        AND object_revision=1)
    OR (SELECT count(*) FROM scopehatch.idempotency_records) <> 2
    OR (SELECT count(*) FROM scopehatch.model_usage_events WHERE status='unknown') <> 2
    THEN RAISE EXCEPTION 'Audit, replay history, or unknown usage missing'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM scopehatch.inference_reservations r
    JOIN scopehatch.inference_accounts a ON a.tenant_id=r.tenant_id
    WHERE r.tenant_id='studio-a' AND r.status='unknown' AND r.dispatched
      AND r.cost_minor IS NULL AND r.reserved_minor=1200
      AND a.held_minor >= 1200 AND a.spent_minor=0
      AND r.usage->>'status'='unknown'
  ) THEN RAISE EXCEPTION 'Outstanding inference reservation or cost hold lost'; END IF;
  SELECT count(*) INTO invalid_count FROM pg_constraint c
    JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE n.nspname='scopehatch' AND NOT c.convalidated;
  IF invalid_count <> 0 THEN RAISE EXCEPTION 'Unvalidated database constraints'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='scopehatch' AND c.relname='projects' AND c.relforcerowsecurity
  ) THEN RAISE EXCEPTION 'Tenant FORCE RLS protection disabled'; END IF;
  BEGIN
    UPDATE scopehatch.scope_deliverables SET evidence='tampered'
    WHERE tenant_id='studio-b' AND project_id='b-demo' AND scope_revision=1;
    RAISE EXCEPTION 'immutable scope mutation unexpectedly succeeded';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $checks$;

-- Even an authenticated restricted runtime login cannot read the other tenant.
BEGIN;
SELECT scopehatch.admin_bind_context('studio-a','a-operator');
SET LOCAL ROLE scopehatch_rehearsal_runtime;
DO $rls$
BEGIN
  IF (SELECT count(*) FROM scopehatch.lookup_verified_subject('a-operator','https://recovery.scopehatch.invalid/')) <> 0
    OR (SELECT count(*) FROM scopehatch.lookup_verified_subject('a-operator','https://wrong.scopehatch.invalid/')) <> 0
    THEN RAISE EXCEPTION 'Restored issuer binding failed'; END IF;
  IF (SELECT count(*) FROM scopehatch.projects) <> 1
    OR (SELECT count(*) FROM scopehatch.projects WHERE tenant_id='studio-b') <> 0
    OR (SELECT count(*) FROM scopehatch.inference_reservations WHERE tenant_id='studio-a') <> 1
    THEN RAISE EXCEPTION 'Tenant A read isolation failed'; END IF;
END $rls$;
COMMIT;
BEGIN;
SELECT scopehatch.admin_bind_context('studio-b','b-operator');
SET LOCAL ROLE scopehatch_rehearsal_runtime;
DO $rls$
BEGIN
  IF (SELECT count(*) FROM scopehatch.projects) <> 1
    OR (SELECT count(*) FROM scopehatch.projects WHERE tenant_id='studio-a') <> 0
    OR (SELECT count(*) FROM scopehatch.inference_reservations) <> 0
    THEN RAISE EXCEPTION 'Tenant B read isolation failed'; END IF;
END $rls$;
COMMIT;
