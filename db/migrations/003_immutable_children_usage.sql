-- Revisions must have an immutable cardinality; otherwise direct SQL could
-- append a child line to an already reviewed immutable parent.
-- This migration backfills existing rows under a narrowly scoped admin-only
-- trigger suspension; run exclusively with restricted migration credentials.
BEGIN;
ALTER TABLE scopehatch.catalog_versions
  ADD COLUMN IF NOT EXISTS service_count integer;
ALTER TABLE scopehatch.scope_revisions
  ADD COLUMN IF NOT EXISTS line_count integer;
ALTER TABLE scopehatch.catalog_versions
  ADD COLUMN IF NOT EXISTS creation_txid bigint NOT NULL DEFAULT txid_current();
ALTER TABLE scopehatch.scope_revisions
  ADD COLUMN IF NOT EXISTS creation_txid bigint NOT NULL DEFAULT txid_current();
ALTER TABLE scopehatch.catalog_versions DISABLE TRIGGER immutable_catalog_versions;
ALTER TABLE scopehatch.scope_revisions DISABLE TRIGGER immutable_scope_revisions;
UPDATE scopehatch.catalog_versions v SET service_count = (
  SELECT count(*)::integer FROM scopehatch.catalog_services s
  WHERE s.tenant_id=v.tenant_id AND s.catalog_version=v.version
) WHERE service_count IS NULL;
UPDATE scopehatch.scope_revisions r SET line_count = (
  SELECT count(*)::integer FROM scopehatch.scope_deliverables d
  WHERE d.tenant_id=r.tenant_id AND d.project_id=r.project_id
    AND d.scope_revision=r.revision
) WHERE line_count IS NULL;
ALTER TABLE scopehatch.catalog_versions ENABLE TRIGGER immutable_catalog_versions;
ALTER TABLE scopehatch.scope_revisions ENABLE TRIGGER immutable_scope_revisions;
ALTER TABLE scopehatch.catalog_versions ALTER COLUMN service_count SET NOT NULL;
ALTER TABLE scopehatch.scope_revisions ALTER COLUMN line_count SET NOT NULL;
DO $constraints$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'catalog_service_count_nonnegative'
    AND conrelid='scopehatch.catalog_versions'::regclass) THEN
   ALTER TABLE scopehatch.catalog_versions ADD CONSTRAINT catalog_service_count_nonnegative
     CHECK (service_count >= 0);
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scope_line_count_nonnegative'
    AND conrelid='scopehatch.scope_revisions'::regclass) THEN
   ALTER TABLE scopehatch.scope_revisions ADD CONSTRAINT scope_line_count_nonnegative
     CHECK (line_count >= 0);
 END IF;
END $constraints$;

CREATE OR REPLACE FUNCTION scopehatch.guard_catalog_service_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, scopehatch
AS $$
DECLARE expected integer;
DECLARE existing integer;
DECLARE owner_id text;
DECLARE parent_txid bigint;
BEGIN
  PERFORM 1 FROM scopehatch.tenants WHERE id=NEW.tenant_id FOR UPDATE;
  SELECT service_count, created_by, creation_txid INTO expected,owner_id,parent_txid
    FROM scopehatch.catalog_versions
   WHERE tenant_id=NEW.tenant_id AND version=NEW.catalog_version;
  SELECT count(*)::integer INTO existing FROM scopehatch.catalog_services
   WHERE tenant_id=NEW.tenant_id AND catalog_version=NEW.catalog_version;
  IF expected IS NULL OR existing >= expected OR
      NEW.service_id IS NULL OR NOT scopehatch.has_role(NEW.tenant_id, ARRAY['owner','operator'])
      OR owner_id IS DISTINCT FROM scopehatch.actor_id()
      OR parent_txid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'immutable catalog version cannot add lines'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION scopehatch.guard_scope_line_insert()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, scopehatch
AS $$
DECLARE expected integer;
DECLARE existing integer;
DECLARE owner_id text;
DECLARE parent_txid bigint;
DECLARE intake_brief text;
BEGIN
  PERFORM 1 FROM scopehatch.tenants WHERE id=NEW.tenant_id FOR UPDATE;
  PERFORM 1 FROM scopehatch.projects
    WHERE tenant_id=NEW.tenant_id AND id=NEW.project_id FOR UPDATE;
  SELECT line_count,author_id,creation_txid INTO expected,owner_id,parent_txid
    FROM scopehatch.scope_revisions
   WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id
     AND revision=NEW.scope_revision;
  SELECT count(*)::integer INTO existing FROM scopehatch.scope_deliverables
   WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id
     AND scope_revision=NEW.scope_revision;
  SELECT i.brief INTO intake_brief
    FROM scopehatch.scope_revisions s
    JOIN scopehatch.intakes i ON (i.tenant_id=s.tenant_id
      AND i.project_id=s.project_id AND i.revision=s.intake_revision)
    WHERE s.tenant_id=NEW.tenant_id AND s.project_id=NEW.project_id
      AND s.revision=NEW.scope_revision;
  IF NEW.source = 'brief' AND
     (NEW.evidence IS NULL OR length(btrim(NEW.evidence))=0
       OR strpos(intake_brief, NEW.evidence)=0) THEN
    RAISE EXCEPTION 'brief evidence is not an exact source substring'
      USING ERRCODE = '22023';
  END IF;
  IF expected IS NULL OR existing >= expected OR NEW.line_no <> existing
      OR NOT scopehatch.has_role(NEW.tenant_id, ARRAY['owner','operator'])
      OR owner_id IS DISTINCT FROM scopehatch.actor_id()
      OR parent_txid IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'immutable scope cannot add lines'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_catalog_service_insert ON scopehatch.catalog_services;
CREATE TRIGGER guard_catalog_service_insert
  BEFORE INSERT ON scopehatch.catalog_services FOR EACH ROW
  EXECUTE FUNCTION scopehatch.guard_catalog_service_insert();
DROP TRIGGER IF EXISTS guard_scope_line_insert ON scopehatch.scope_deliverables;
CREATE TRIGGER guard_scope_line_insert
  BEFORE INSERT ON scopehatch.scope_deliverables FOR EACH ROW
  EXECUTE FUNCTION scopehatch.guard_scope_line_insert();

-- Approval and pricing require complete line sets, not partially constructed
-- versions that could be completed by a later transaction.
CREATE OR REPLACE FUNCTION scopehatch.assert_complete_catalog(p_tenant text,p_version integer)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,scopehatch AS $$
BEGIN
  IF (SELECT service_count FROM scopehatch.catalog_versions
      WHERE tenant_id=p_tenant AND version=p_version)
    IS DISTINCT FROM
    (SELECT count(*)::integer FROM scopehatch.catalog_services
      WHERE tenant_id=p_tenant AND catalog_version=p_version) THEN
    RAISE EXCEPTION 'incomplete catalog' USING ERRCODE='23514';
  END IF;
END $$;
CREATE OR REPLACE FUNCTION scopehatch.assert_complete_scope(
  p_tenant text,p_project text,p_revision integer
) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,scopehatch AS $$
BEGIN
  IF (SELECT line_count FROM scopehatch.scope_revisions
      WHERE tenant_id=p_tenant AND project_id=p_project AND revision=p_revision)
    IS DISTINCT FROM
    (SELECT count(*)::integer FROM scopehatch.scope_deliverables
      WHERE tenant_id=p_tenant AND project_id=p_project AND scope_revision=p_revision) THEN
    RAISE EXCEPTION 'incomplete scope' USING ERRCODE='23514';
  END IF;
END $$;
-- Hook completeness onto estimate/review checks via safe AFTER insert checks.
-- Scope line and catalog count are frozen once their declared cardinality
-- has been filled. A quote insert validates both before storing its state.
CREATE OR REPLACE FUNCTION scopehatch.guard_completed_quote() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,scopehatch AS $$
BEGIN
  PERFORM scopehatch.assert_complete_catalog(NEW.tenant_id,NEW.catalog_version);
  PERFORM scopehatch.assert_complete_scope(NEW.tenant_id,NEW.project_id,NEW.scope_revision);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS complete_quote_insert ON scopehatch.estimate_revisions;
CREATE TRIGGER complete_quote_insert BEFORE INSERT ON scopehatch.estimate_revisions
FOR EACH ROW EXECUTE FUNCTION scopehatch.guard_completed_quote();

-- Provider usage is append-only, tenant-bound and does not coerce unavailable
-- measurement into zero. Governance can integrate this in another PR.
CREATE TABLE IF NOT EXISTS scopehatch.model_usage_events (
  tenant_id text NOT NULL REFERENCES scopehatch.tenants(id),
  id text NOT NULL,
  project_id text,
  actor_id text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('reported','unknown')),
  input_tokens bigint CHECK (input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens bigint CHECK (output_tokens BETWEEN 0 AND 9007199254740991),
  request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,id),
  FOREIGN KEY (tenant_id,project_id)
    REFERENCES scopehatch.projects(tenant_id,id),
  FOREIGN KEY (tenant_id,actor_id)
    REFERENCES scopehatch.memberships(tenant_id,principal_id),
  CONSTRAINT usage_reported_has_measurement CHECK (
    status <> 'reported' OR input_tokens IS NOT NULL OR output_tokens IS NOT NULL
  ),
  CONSTRAINT usage_unknown_is_null CHECK (
    status <> 'unknown' OR (input_tokens IS NULL AND output_tokens IS NULL)
  )
);
DROP TRIGGER IF EXISTS immutable_usage_event ON scopehatch.model_usage_events;
CREATE TRIGGER immutable_usage_event
  BEFORE UPDATE OR DELETE ON scopehatch.model_usage_events
  FOR EACH ROW EXECUTE FUNCTION scopehatch.reject_mutation();
DROP TRIGGER IF EXISTS guard_usage_event ON scopehatch.model_usage_events;
CREATE TRIGGER guard_usage_event
  BEFORE INSERT ON scopehatch.model_usage_events
  FOR EACH ROW EXECUTE FUNCTION scopehatch.guard_audit_insert();
ALTER TABLE scopehatch.model_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE scopehatch.model_usage_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_access ON scopehatch.model_usage_events;
CREATE POLICY tenant_access ON scopehatch.model_usage_events FOR ALL TO scopehatch_app
  USING (scopehatch.is_member(tenant_id))
  WITH CHECK (scopehatch.is_member(tenant_id));
REVOKE ALL ON scopehatch.model_usage_events FROM PUBLIC;
GRANT SELECT,INSERT ON scopehatch.model_usage_events TO scopehatch_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA scopehatch FROM PUBLIC;
GRANT EXECUTE ON FUNCTION scopehatch.assert_complete_catalog(text,integer) TO scopehatch_app;
GRANT EXECUTE ON FUNCTION scopehatch.assert_complete_scope(text,text,integer) TO scopehatch_app;
ALTER TABLE scopehatch.idempotency_records ALTER COLUMN response SET NOT NULL;
COMMIT;
